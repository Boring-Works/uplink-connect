import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

interface DashboardClient {
	ws: WebSocket;
	subscribedTopics: Set<string>;
}

interface DashboardMessage {
	type: "subscribe" | "unsubscribe" | "ping" | "metrics";
	topics?: string[];
	data?: unknown;
}

const BROADCAST_INTERVAL_MS = 5000;

export class DashboardStreamDO extends DurableObject<Env> {
	private clients: Map<WebSocket, DashboardClient> = new Map();
	private broadcastTimer: number | null = null;

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
		this.clients.set(server, { ws: server, subscribedTopics: new Set() });

		if (this.broadcastTimer === null) {
			this.startBroadcasting();
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			const text = typeof message === "string" ? message : new TextDecoder().decode(message);
			const data = JSON.parse(text) as DashboardMessage;
			const client = this.clients.get(ws);
			if (!client) return;

			switch (data.type) {
				case "subscribe": {
					for (const topic of data.topics ?? []) {
						client.subscribedTopics.add(topic);
					}
					ws.send(JSON.stringify({ type: "subscribed", topics: Array.from(client.subscribedTopics) }));
					break;
				}
				case "unsubscribe": {
					for (const topic of data.topics ?? []) {
						client.subscribedTopics.delete(topic);
					}
					break;
				}
				case "ping": {
					ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
					break;
				}
			}
		} catch {
			// Ignore malformed messages
		}
	}

	async webSocketClose(ws: WebSocket) {
		this.clients.delete(ws);
		if (this.clients.size === 0 && this.broadcastTimer !== null) {
			clearInterval(this.broadcastTimer);
			this.broadcastTimer = null;
		}
	}

	private startBroadcasting(): void {
		this.broadcastTimer = setInterval(() => {
			this.broadcastMetrics();
		}, BROADCAST_INTERVAL_MS) as unknown as number;
	}

	private async broadcastMetrics(): Promise<void> {
		if (this.clients.size === 0) return;

		const metrics = await this.gatherMetrics();
		const message = JSON.stringify({ type: "metrics", data: metrics });

		for (const client of this.clients.values()) {
			if (client.subscribedTopics.has("metrics") || client.subscribedTopics.has("all")) {
				try {
					client.ws.send(message);
				} catch {
					// Client may have disconnected
				}
			}
		}
	}

	private async gatherMetrics(): Promise<Record<string, unknown>> {
		const db = this.env.CONTROL_DB;

		const [
			sourceCount,
			runSummary,
			queueMetrics,
			alertCount,
		] = await Promise.all([
			db.prepare("SELECT COUNT(*) as count FROM source_configs WHERE deleted_at IS NULL").first<{ count: number }>(),
			db.prepare(`
				SELECT status, COUNT(*) as count
				FROM ingest_runs
				WHERE created_at > unixepoch() - 86400
				GROUP BY status
			`).all(),
			db.prepare(`
				SELECT
					SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
					SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing
				FROM ingest_queue_status
			`).first<{ pending: number; processing: number }>(),
			db.prepare("SELECT COUNT(*) as count FROM alerts_active WHERE resolved_at IS NULL").first<{ count: number }>(),
		]);

		const runTotals: Record<string, number> = {};
		for (const row of runSummary.results ?? []) {
			const r = row as { status: string; count: number };
			runTotals[r.status] = r.count;
		}

		return {
			timestamp: new Date().toISOString(),
			sources: {
				total: sourceCount?.count ?? 0,
			},
			runs24h: runTotals,
			queue: {
				pending: queueMetrics?.pending ?? 0,
				processing: queueMetrics?.processing ?? 0,
			},
			alerts: {
				active: alertCount?.count ?? 0,
			},
		};
	}
}
