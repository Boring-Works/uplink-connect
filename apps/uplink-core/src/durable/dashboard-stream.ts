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
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_CLIENTS = 100;

export class DashboardStreamDO extends DurableObject<Env> {
	private clients: Map<WebSocket, DashboardClient> = new Map();

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

		if (this.clients.size >= MAX_CLIENTS) {
			return new Response("Too many connections", { status: 503 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server);
		this.clients.set(server, { ws: server, subscribedTopics: new Set() });

		await this.ensureAlarm();

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
		if (this.clients.size === 0) {
			const alarm = await this.ctx.storage.getAlarm();
			if (alarm) {
				await this.ctx.storage.deleteAlarm();
			}
		}
	}

	async webSocketError(ws: WebSocket) {
		this.clients.delete(ws);
		if (this.clients.size === 0) {
			const alarm = await this.ctx.storage.getAlarm();
			if (alarm) {
				await this.ctx.storage.deleteAlarm();
			}
		}
	}

	async alarm(): Promise<void> {
		if (this.clients.size === 0) {
			return;
		}

		try {
			await this.broadcastMetrics();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[DashboardStreamDO] broadcastMetrics failed:", message);
		}

		try {
			await this.ctx.storage.setAlarm(Date.now() + BROADCAST_INTERVAL_MS);
		} catch (alarmErr) {
			console.error("[DashboardStreamDO] Failed to reschedule alarm:", alarmErr);
		}
	}

	private async ensureAlarm(): Promise<void> {
		const alarm = await this.ctx.storage.getAlarm();
		if (!alarm) {
			await this.ctx.storage.setAlarm(Date.now() + BROADCAST_INTERVAL_MS);
		}
	}

	private async broadcastMetrics(): Promise<void> {
		if (this.clients.size === 0) return;

		let metrics: Record<string, unknown>;
		try {
			metrics = await this.gatherMetrics();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[DashboardStreamDO] gatherMetrics failed:", message);
			metrics = { error: "Failed to gather metrics" };
		}

		const message = JSON.stringify({ type: "metrics", data: metrics });
		const deadSockets: WebSocket[] = [];

		for (const [socket, client] of this.clients.entries()) {
			if (client.subscribedTopics.has("metrics") || client.subscribedTopics.has("all")) {
				try {
					socket.send(message);
				} catch {
					deadSockets.push(socket);
				}
			}
		}

		for (const socket of deadSockets) {
			this.clients.delete(socket);
		}
	}

	private async gatherMetrics(): Promise<Record<string, unknown>> {
		const db = this.env.CONTROL_DB;

		const [
			sourceCount,
			runSummary,
			queueMetrics,
			alertCount,
			errorCount,
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
					SUM(CASE WHEN status IN ('received', 'enqueued') THEN 1 ELSE 0 END) as pending,
					SUM(CASE WHEN status IN ('collecting', 'normalizing') THEN 1 ELSE 0 END) as processing
				FROM ingest_runs
				WHERE created_at > unixepoch() - 3600
			`).first<{ pending: number; processing: number }>(),
			db.prepare("SELECT COUNT(*) as count FROM alerts_active WHERE resolved_at IS NULL").first<{ count: number }>(),
			db.prepare("SELECT COUNT(*) as count FROM ingest_errors WHERE status = 'pending'").first<{ count: number }>(),
		]);

		const runTotals: Record<string, number> = {};
		for (const row of runSummary.results ?? []) {
			const r = row as { status: string; count: number };
			runTotals[r.status] = r.count;
		}

		// Approximate queue lag from oldest pending run in minutes
		const oldestPending = await db.prepare(
			`SELECT MIN(created_at) as oldest FROM ingest_runs WHERE status IN ('received', 'enqueued')`
		).first<{ oldest: number }>();
		const lagSeconds = oldestPending?.oldest ? Math.floor(Date.now() / 1000) - oldestPending.oldest : 0;

		return {
			timestamp: new Date().toISOString(),
			sources: {
				total: sourceCount?.count ?? 0,
			},
			runs24h: runTotals,
			queue: {
				pending: queueMetrics?.pending ?? 0,
				processing: queueMetrics?.processing ?? 0,
				lagSeconds,
			},
			alerts: {
				active: alertCount?.count ?? 0,
			},
			errors: {
				pending: errorCount?.count ?? 0,
			},
		};
	}
}
