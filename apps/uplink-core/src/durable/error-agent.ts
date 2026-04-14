import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	sources?: ErrorSource[];
}

interface ErrorSource {
	errorId: string;
	message: string;
	occurredAt: number;
	score: number;
}

interface AgentMessage {
	type: "chat" | "ping" | "clear" | "history";
	content?: string;
}

const MESSAGES_KEY = "messages";
const MAX_MESSAGES = 50;

export class ErrorAgentDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong")
		);
	}

	async fetch(request: Request): Promise<Response> {
		const upgrade = request.headers.get("Upgrade");
		if (upgrade !== "websocket") {
			return new Response("Expected websocket", { status: 400 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			const text = typeof message === "string" ? message : new TextDecoder().decode(message);
			const data = JSON.parse(text) as AgentMessage;

			switch (data.type) {
				case "ping": {
					ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
					break;
				}
				case "chat": {
					if (data.content) {
						await this.handleChat(ws, data.content);
					}
					break;
				}
				case "clear": {
					await this.ctx.storage.put(MESSAGES_KEY, []);
					ws.send(JSON.stringify({ type: "cleared" }));
					break;
				}
				case "history": {
					const history = await this.getHistory();
					ws.send(JSON.stringify({ type: "history", data: history }));
					break;
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			ws.send(JSON.stringify({ type: "error", error: errorMessage }));
		}
	}

	private async getMessages(): Promise<ChatMessage[]> {
		const stored = await this.ctx.storage.get<ChatMessage[]>(MESSAGES_KEY);
		return stored ?? [];
	}

	private async addMessage(message: ChatMessage): Promise<void> {
		const messages = await this.getMessages();
		messages.push(message);
		if (messages.length > MAX_MESSAGES) {
			messages.shift();
		}
		await this.ctx.storage.put(MESSAGES_KEY, messages);
	}

	private async getHistory(): Promise<Array<{ role: string; content: string }>> {
		const messages = await this.getMessages();
		return messages.map((m) => ({ role: m.role, content: m.content }));
	}

	private async handleChat(ws: WebSocket, content: string) {
		await this.addMessage({ role: "user", content });

		// Search for similar errors using Vectorize
		const queryEmbedding = await this.embedText(content);
		const similarErrors = await this.searchSimilarErrors(queryEmbedding);

		const systemPrompt = this.buildSystemPrompt(similarErrors);
		const messages = await this.getMessages();

		const messagesForAi = [
			{ role: "system", content: systemPrompt },
			...messages.map((m) => ({ role: m.role, content: m.content })),
		];

		const result = (await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
			messages: messagesForAi,
			stream: true,
		})) as unknown as ReadableStream;

		let fullResponse = "";
		const reader = result.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split("\n");

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed === "data: [DONE]") continue;
				if (!trimmed.startsWith("data: ")) continue;

				const jsonStr = trimmed.slice("data: ".length).trim();
				if (!jsonStr) continue;

				try {
					const parsed = JSON.parse(jsonStr);
					if (parsed.response) {
						fullResponse += parsed.response;
						ws.send(JSON.stringify({ type: "text", content: parsed.response }));
					}
				} catch {
					// Ignore parse errors in stream
				}
			}
		}

		const sources: ErrorSource[] = similarErrors.map((e) => ({
			errorId: e.errorId,
			message: e.message,
			occurredAt: e.occurredAt,
			score: e.score,
		}));

		await this.addMessage({ role: "assistant", content: fullResponse, sources });
		ws.send(JSON.stringify({ type: "done", sources }));
	}

	private async embedText(text: string): Promise<number[]> {
		const result = await this.env.AI.run("@cf/baai/bge-small-en-v1.5", {
			text: [text],
		});
		const output = result as { data?: number[][] };
		const embeddings = output.data?.[0];
		if (!embeddings) {
			throw new Error("Failed to generate embedding");
		}
		return Array.from(embeddings);
	}

	private async searchSimilarErrors(
		embedding: number[],
		topK = 5
	): Promise<Array<{ errorId: string; message: string; occurredAt: number; score: number }>> {
		try {
			const results = await this.env.ENTITY_INDEX.query(embedding, {
				topK,
				namespace: "errors",
				returnMetadata: true,
				returnValues: false,
			});

			return results.matches.map((m) => ({
				errorId: (m.metadata?.errorId as string) ?? "unknown",
				message: (m.metadata?.message as string) ?? "",
				occurredAt: (m.metadata?.occurredAt as number) ?? 0,
				score: m.score,
			}));
		} catch (error) {
			console.error("Error search failed:", error);
			return [];
		}
	}

	private buildSystemPrompt(similarErrors: ErrorSource[]): string {
		const context =
			similarErrors.length > 0
				? similarErrors
						.map(
							(e) =>
							`
Error ${e.errorId} (score: ${e.score.toFixed(3)}):
${e.message}
`
						)
						.join("\n---\n")
				: "No similar errors found in the knowledge base.";

		return `You are Uplink Connect's Error Analysis Agent. You help operators diagnose and resolve ingestion errors.

Here are similar past errors from the knowledge base:

${context}

Analyze the user's error description and provide:
1. Likely root cause
2. Suggested fix or investigation steps
3. Relevant internal documentation or runbook references

Be concise and technical. If you don't have enough information, say so clearly.`;
	}
}
