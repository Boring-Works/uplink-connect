import { DurableObject } from "cloudflare:workers";
import { embed, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
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

const MAX_MESSAGES = 50;
const MAX_CLIENTS = 20;
const MAX_MESSAGES_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const SCHEMA_VERSION_KEY = "_schema_version";
const CURRENT_SCHEMA_VERSION = 1;
// Must match gateway_id in apps/uplink-core/wrangler.jsonc
const AI_GATEWAY_ID = "uplink-ai-gateway";

interface ClientState {
	rateLimit: ClientRateLimit;
	abortController: AbortController;
}

interface ClientRateLimit {
	messageCount: number;
	windowStart: number;
}

export class ErrorAgentDO extends DurableObject<Env> {
	private sql: SqlStorage;
	private workersAi?: ReturnType<typeof createWorkersAI>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong")
		);

		ctx.blockConcurrencyWhile(async () => {
			await this.ensureSchema();
		});
	}

	private getSchemaVersion(): number {
		try {
			const result = this.sql.exec("SELECT value FROM _metadata WHERE key = ?", SCHEMA_VERSION_KEY)
				.one() as { value: string } | null;
			return result ? parseInt(result.value, 10) : 0;
		} catch {
			return 0;
		}
	}

	private setSchemaVersion(version: number): void {
		this.sql.exec("CREATE TABLE IF NOT EXISTS _metadata (key TEXT PRIMARY KEY, value TEXT)");
		this.sql.exec("INSERT OR REPLACE INTO _metadata (key, value) VALUES (?, ?)", SCHEMA_VERSION_KEY, String(version));
	}

	private async ensureSchema(): Promise<void> {
		const version = this.getSchemaVersion();
		if (version >= CURRENT_SCHEMA_VERSION) {
			this.trimMessages();
			return;
		}

		if (version < 1) {
			this.sql.exec(`
				CREATE TABLE IF NOT EXISTS chat_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
					content TEXT NOT NULL,
					sources_json TEXT,
					created_at INTEGER NOT NULL DEFAULT (unixepoch())
				)
			`);
		}

		this.setSchemaVersion(CURRENT_SCHEMA_VERSION);
		this.trimMessages();
	}

	private trimMessages(): void {
		this.sql.exec(`
			DELETE FROM chat_messages
			WHERE id <= (
				SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1 OFFSET ?
			)
		`, MAX_MESSAGES);
	}

	private clients: Set<WebSocket> = new Set();
	private clientStates: Map<WebSocket, ClientState> = new Map();

	async fetch(request: Request): Promise<Response> {
		const upgrade = request.headers.get("Upgrade");
		if (upgrade !== "websocket") {
			return new Response("Expected websocket", { status: 400 });
		}

		// Validate auth token from query string
		const url = new URL(request.url);
		const token = url.searchParams.get("token");
		if (!this.isValidAgentToken(token)) {
			return new Response("Unauthorized", { status: 401 });
		}

		if (this.clients.size >= MAX_CLIENTS) {
			return new Response("Too many connections", { status: 503 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		this.clients.add(server);
		this.clientStates.set(server, {
			rateLimit: { messageCount: 0, windowStart: 0 },
			abortController: new AbortController(),
		});

		return new Response(null, { status: 101, webSocket: client });
	}

	private isValidAgentToken(token: string | null): boolean {
		if (!token || !this.env.CORE_INTERNAL_KEY) {
			return false;
		}
		// Simple constant-time comparison to prevent timing attacks
		const expected = this.env.CORE_INTERNAL_KEY;
		if (token.length !== expected.length) {
			return false;
		}
		let result = 0;
		for (let i = 0; i < token.length; i++) {
			result |= token.charCodeAt(i) ^ expected.charCodeAt(i);
		}
		return result === 0;
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
						if (!this.checkRateLimit(ws)) {
							ws.send(JSON.stringify({ type: "error", error: "Rate limit exceeded: max 10 messages per minute" }));
							break;
						}
						await this.handleChat(ws, data.content);
					}
					break;
				}
				case "clear": {
					this.sql.exec("DELETE FROM chat_messages");
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

	async webSocketClose(ws: WebSocket) {
		this.abortClientStream(ws);
		this.clients.delete(ws);
		this.clientStates.delete(ws);
	}

	async webSocketError(ws: WebSocket) {
		this.abortClientStream(ws);
		this.clients.delete(ws);
		this.clientStates.delete(ws);
	}

	private abortClientStream(ws: WebSocket): void {
		const state = this.clientStates.get(ws);
		if (state) {
			state.abortController.abort();
		}
	}

	private checkRateLimit(ws: WebSocket): boolean {
		const now = Date.now();
		const state = this.clientStates.get(ws);
		if (!state) return false;

		const limit = state.rateLimit;

		if (now - limit.windowStart > RATE_LIMIT_WINDOW_MS) {
			// New window
			state.rateLimit = { messageCount: 1, windowStart: now };
			return true;
		}

		if (limit.messageCount >= MAX_MESSAGES_PER_MINUTE) {
			return false;
		}

		limit.messageCount++;
		return true;
	}

	private async getMessages(): Promise<ChatMessage[]> {
		const rows = this.sql.exec(
			`SELECT role, content, sources_json FROM chat_messages ORDER BY id ASC`
		) as Iterable<{ role: string; content: string; sources_json: string | null }>;

		const messages: ChatMessage[] = [];
		for (const row of rows) {
			const msg: ChatMessage = {
				role: row.role as "user" | "assistant" | "system",
				content: row.content,
			};
			if (row.sources_json) {
				try {
					msg.sources = JSON.parse(row.sources_json) as ErrorSource[];
				} catch {
					// ignore corrupt sources_json
				}
			}
			messages.push(msg);
		}
		return messages;
	}

	private async addMessage(message: ChatMessage): Promise<void> {
		this.sql.exec(
			`INSERT INTO chat_messages (role, content, sources_json) VALUES (?, ?, ?)`,
			message.role,
			message.content,
			message.sources ? JSON.stringify(message.sources) : null
		);

		// Trim to MAX_MESSAGES
		this.sql.exec(`
			DELETE FROM chat_messages
			WHERE id <= (
				SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1 OFFSET ?
			)
		`, MAX_MESSAGES);
	}

	private async getHistory(): Promise<Array<{ role: string; content: string }>> {
		const rows = this.sql.exec(
			`SELECT role, content FROM chat_messages ORDER BY id ASC`
		) as Iterable<{ role: string; content: string }>;

		return Array.from(rows).map((m) => ({ role: m.role, content: m.content }));
	}

	private async handleChat(ws: WebSocket, content: string) {
		await this.addMessage({ role: "user", content });

		// Search for similar errors using Vectorize
		const queryEmbedding = await this.embedText(content);
		const similarErrors = await this.searchSimilarErrors(queryEmbedding);

		const systemPrompt = this.buildSystemPrompt(similarErrors);
		const messages = await this.getMessages();

		const messagesForAi = messages.map((m) => ({
			role: m.role,
			content: m.content,
		}));

		// AI SDK v6 + workers-ai-provider with optional AI Gateway
		const workersAi = this.getWorkersAI();
		const clientState = this.clientStates.get(ws);
		const abortSignal = clientState?.abortController.signal;

		const result = streamText({
			model: workersAi("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
			system: systemPrompt,
			messages: messagesForAi,
			maxOutputTokens: 2048,
			timeout: { totalMs: 60_000, chunkMs: 15_000 },
			abortSignal,
			onError: ({ error }) => {
				console.error("[ErrorAgentDO] streamText error:", error);
			},
			onFinish: ({ totalUsage }) => {
				console.log("[ErrorAgentDO] stream complete", {
					inputTokens: totalUsage?.inputTokens,
					outputTokens: totalUsage?.outputTokens,
				});
			},
		});

		let fullResponse = "";
		try {
			for await (const textDelta of result.textStream) {
				fullResponse += textDelta;
				// Guard against sending to a closed socket (race with disconnect)
				if (this.clients.has(ws)) {
					try {
						ws.send(JSON.stringify({ type: "text", content: textDelta }));
					} catch (sendErr) {
						// Socket closed mid-send; abort will propagate on next iteration
						console.warn("[ErrorAgentDO] ws.send failed, socket likely closed:", sendErr);
					}
				}
			}
		} catch (streamError) {
			// Don't send stream-error to client if they initiated the abort
			if (abortSignal?.aborted) {
				console.log("[ErrorAgentDO] Stream aborted by client disconnect");
				return;
			}
			// Notify client that the stream failed mid-generation
			if (this.clients.has(ws)) {
				try {
					ws.send(JSON.stringify({
						type: "stream-error",
						partialContent: fullResponse,
						error: streamError instanceof Error ? streamError.message : String(streamError),
					}));
				} catch {
					// Socket closed before error could be sent
				}
			}
			// Re-throw so the outer handler logs it and the assistant message is NOT saved
			throw streamError;
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

	private getWorkersAI(): ReturnType<typeof createWorkersAI> {
		if (!this.workersAi) {
			this.workersAi = createWorkersAI({
				binding: this.env.AI,
				gateway: { id: AI_GATEWAY_ID },
			});
		}
		return this.workersAi;
	}

	private async embedText(text: string): Promise<number[]> {
		const workersAi = this.getWorkersAI();
		const result = await embed({
			model: workersAi.embedding("@cf/baai/bge-small-en-v1.5"),
			value: text,
		});
		return result.embedding;
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
