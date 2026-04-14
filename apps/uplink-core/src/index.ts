import { Hono } from "hono";
import type { Env } from "./types";
import { ensureInternalAuth } from "./lib/auth";
import { processQueueBatch } from "./lib/processing";
import { getEnabledSchedulesByCron } from "./lib/scheduler";
import { getCoordinatorStub, acquireLease } from "./lib/coordinator-client";
import { SourceCoordinator } from "./durable/source-coordinator";
import { BrowserManagerDO } from "./durable/browser-manager";
import { NotificationDispatcher } from "./durable/notification-dispatcher";
import { DashboardStreamDO } from "./durable/dashboard-stream";
import { ErrorAgentDO } from "./durable/error-agent";
import { CollectionWorkflow } from "./workflows/collection-workflow";
import { RetentionWorkflow } from "./workflows/retention-workflow";

import healthRoutes from "./routes/health";
import runsRoutes from "./routes/runs";
import sourcesRoutes from "./routes/sources";
import entitiesRoutes from "./routes/entities";
import artifactsRoutes from "./routes/artifacts";
import alertsRoutes from "./routes/alerts";
import metricsRoutes from "./routes/metrics";
import errorsRoutes from "./routes/errors";
import dashboardRoutes from "./routes/dashboard";
import healthMonitorRoutes from "./routes/health-monitor";
import settingsRoutes from "./routes/settings";
import browserRoutes from "./routes/browser";
import notificationRoutes from "./routes/notifications";
import agentRoutes from "./routes/agents";
import exportRoutes from "./routes/export";
import schedulerRoutes from "./routes/scheduler";

const app = new Hono<{ Bindings: Env }>();

// Health (no auth)
app.route("/", healthRoutes);

// Internal auth middleware
app.use("/internal/*", async (c, next) => {
	const authFailure = ensureInternalAuth(c);
	if (authFailure) {
		return authFailure;
	}
	await next();
});

// Route modules
app.route("/", runsRoutes);
app.route("/", sourcesRoutes);
app.route("/", entitiesRoutes);
app.route("/", artifactsRoutes);
app.route("/", alertsRoutes);
app.route("/", metricsRoutes);
app.route("/", errorsRoutes);
app.route("/", dashboardRoutes);
app.route("/", healthMonitorRoutes);
app.route("/", settingsRoutes);
app.route("/", browserRoutes);
app.route("/", notificationRoutes);
app.route("/", agentRoutes);
app.route("/", exportRoutes);
app.route("/", schedulerRoutes);

async function runSyntheticMonitoring(env: Env): Promise<void> {
	const endpoints = [
		{ name: "uplink-core", url: "https://uplink-core.codyboring.workers.dev/health" },
		{ name: "uplink-edge", url: "https://uplink-edge.codyboring.workers.dev/health" },
	];

	for (const endpoint of endpoints) {
		try {
			const start = Date.now();
			const res = await fetch(endpoint.url, { method: "GET" });
			const latencyMs = Date.now() - start;
			const body = await res.json().catch(() => ({} as Record<string, unknown>));
			const healthy = res.ok && (body as { ok?: boolean }).ok === true;

			await env.OPS_METRICS.writeDataPoint({
				doubles: [latencyMs],
				indexes: [endpoint.name],
			});

			if (!healthy) {
				console.error(`[monitor] ${endpoint.name} unhealthy`, { status: res.status, body });
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[monitor] ${endpoint.name} check failed`, { error: message });
		}
	}
}

async function triggerScheduledSources(env: Env, cron: string, ctx?: ExecutionContext): Promise<void> {
	const byCron = await getEnabledSchedulesByCron(env.CONTROL_DB);
	const sourceIds = byCron[cron];
	if (!sourceIds || sourceIds.length === 0) return;

	for (const sourceId of sourceIds) {
		try {
			const coordinator = getCoordinatorStub(env, sourceId);
			const lease = await acquireLease(coordinator, {
				requestedBy: "scheduler-cron",
				ttlSeconds: 300,
			});
			if (!lease.acquired) {
				console.warn(`[scheduler] could not acquire lease for ${sourceId}: ${lease.reason}`);
				continue;
			}
			if (!lease.leaseToken) {
				console.warn(`[scheduler] no lease token for ${sourceId}`);
				continue;
			}

			const doUrl = new URL("https://source-coordinator/collect");
			doUrl.searchParams.set("sourceId", sourceId);
			doUrl.searchParams.set("leaseToken", lease.leaseToken);
			doUrl.searchParams.set("triggeredBy", "scheduler-cron");

			// Fire-and-forget with waitUntil if available
			const doPromise = coordinator.fetch(doUrl.toString(), { method: "POST" }).catch((err) => {
				console.error(`[scheduler] cron trigger failed for ${sourceId}:`, err);
			});
			if (ctx) {
				ctx.waitUntil(doPromise);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[scheduler] error triggering ${sourceId}:`, message);
		}
	}
}

export default {
	async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, executionCtx);
	},

	async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
		await processQueueBatch(batch, env);
	},

	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		await runSyntheticMonitoring(env);
		await triggerScheduledSources(env, controller.cron, _ctx);
	},
};

export { SourceCoordinator, BrowserManagerDO, NotificationDispatcher, DashboardStreamDO, ErrorAgentDO, CollectionWorkflow, RetentionWorkflow };
