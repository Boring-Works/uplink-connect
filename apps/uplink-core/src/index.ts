import { Hono } from "hono";
import {
	EntitySearchRequestSchema,
	ErrorFilterSchema,
	ErrorRetryRequestSchema,
	IngestEnvelopeSchema,
	SourceConfigSchema,
	SourceTriggerRequestSchema,
	createIngestQueueMessage,
	toIsoNow,
} from "@uplink/contracts";
import type { Env } from "./types";
import { ensureInternalAuth } from "./lib/auth";
import {
	acquireLease,
	getCoordinatorState,
	getCoordinatorStub,
	getBrowserManagerStub,
} from "./lib/coordinator-client";
import {
	getArtifact,
	getRun,
	getSourceConfigWithPolicy,
	insertRunIfMissing,
	listRuns,
	listIngestErrors,
	upsertRuntimeSnapshot,
	upsertSourceConfig,
	softDeleteSource,
	restoreSource,
	permanentlyDeleteSource,
	listSources,
} from "./lib/db";
import { sendNotification, testNotificationChannel } from "./lib/notifications";
import { processQueueBatch, retryFailedOperation } from "./lib/processing";
import { querySimilarEntities } from "./lib/vectorize";
import type { VectorizeVectorMetadataFilter } from "./lib/vectorize";
import { SourceCoordinator } from "./durable/source-coordinator";
import { BrowserManagerDO } from "./durable/browser-manager";
import { CollectionWorkflow } from "./workflows/collection-workflow";
import { RetentionWorkflow } from "./workflows/retention-workflow";
import {
	listActiveAlerts,
	createAlert,
	acknowledgeAlert,
	resolveAlert,
	runAllAlertChecks,
	autoResolveAlerts,
	parseAlertConfiguration,
	type AlertSeverity,
	type AlertType,
} from "./lib/alerting";
import {
	getPerSourceMetrics,
	getAllSourceMetrics,
	getQueueMetrics,
	getEntityMetrics,
	getSystemMetrics,
} from "./lib/metrics";
import {
	getComponentHealth,
	getPipelineTopology,
	getDataFlowMetrics,
	getSourceHealthTimeline,
} from "./lib/health-monitor";
import { getSettings, saveSettings, logAuditEvent, getAuditLog } from "./lib/settings";
import { getRunTrace, getEntityLineage, getSourceRunTree } from "./lib/tracing";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
	c.json({
		ok: true,
		service: "uplink-core",
		now: toIsoNow(),
	}),
);

app.use("/internal/*", async (c, next) => {
	const authFailure = ensureInternalAuth(c);
	if (authFailure) {
		return authFailure;
	}
	await next();
});

app.get("/internal/runs", async (c) => {
	const limitRaw = c.req.query("limit") ?? "50";
	const offsetRaw = c.req.query("offset") ?? "0";
	const limit = Number.parseInt(limitRaw, 10);
	const offset = Number.parseInt(offsetRaw, 10);
	const result = await listRuns(c.env.CONTROL_DB, {
		limit: Number.isFinite(limit) ? limit : 50,
		offset: Number.isFinite(offset) ? offset : 0,
	});
	return c.json(result);
});

app.get("/internal/runs/:runId", async (c) => {
	const runId = c.req.param("runId");
	const run = await getRun(c.env.CONTROL_DB, runId);
	if (!run) {
		return c.json({ error: "Run not found" }, 404);
	}

	return c.json(run);
});

app.post("/internal/runs/:runId/replay", async (c) => {
	const runId = c.req.param("runId");
	const run = await getRun(c.env.CONTROL_DB, runId);
	if (!run) {
		return c.json({ error: "Run not found" }, 404);
	}

	const envelopeJson = run.envelope_json;
	if (typeof envelopeJson !== "string") {
		return c.json({ error: "Run does not contain replayable envelope" }, 400);
	}

	let parsedEnvelopeJson: unknown;
	try {
		parsedEnvelopeJson = JSON.parse(envelopeJson);
	} catch {
		return c.json({ error: "Stored run envelope is not valid JSON" }, 400);
	}

	const envelope = IngestEnvelopeSchema.safeParse(parsedEnvelopeJson);
	if (!envelope.success) {
		return c.json({ error: "Stored run envelope is invalid for replay" }, 400);
	}

	const runStatus = typeof run.status === "string" ? run.status : "unknown";
	if (["received", "collecting", "enqueued", "persisted"].includes(runStatus)) {
		return c.json({ error: `Run ${runId} is still in progress and cannot be replayed` }, 409);
	}

	const isPlaceholder = envelope.data.metadata?.placeholder === true;
	if (isPlaceholder) {
		return c.json({ error: `Run ${runId} is a placeholder collection record` }, 409);
	}

	const replayRunId = `replay:${runId}:${crypto.randomUUID()}`;
	const replayEnvelope = {
		...envelope.data,
		ingestId: replayRunId,
		metadata: {
			...(envelope.data.metadata ?? {}),
			replayOf: runId,
			replayedAt: toIsoNow(),
		},
	};

	await c.env.INGEST_QUEUE.send(
		createIngestQueueMessage(replayEnvelope, {
			requestId: c.req.header("x-request-id") ?? crypto.randomUUID(),
		}),
	);

	await insertRunIfMissing(c.env.CONTROL_DB, {
		runId: replayRunId,
		sourceId: replayEnvelope.sourceId,
		sourceName: replayEnvelope.sourceName,
		sourceType: replayEnvelope.sourceType,
		status: "replayed",
		collectedAt: replayEnvelope.collectedAt,
		receivedAt: toIsoNow(),
		recordCount: replayEnvelope.records.length,
		envelope: replayEnvelope,
		triggeredBy: "replay",
		replayOfRunId: runId,
	});

	return c.json({ ok: true, replayRunId }, 202);
});

app.get("/internal/artifacts/:artifactId", async (c) => {
	const artifactId = c.req.param("artifactId");
	const artifact = await getArtifact(c.env.CONTROL_DB, artifactId);
	if (!artifact) {
		return c.json({ error: "Artifact not found" }, 404);
	}

	return c.json(artifact);
});

app.get("/internal/sources", async (c) => {
	const limitRaw = c.req.query("limit") ?? "50";
	const offsetRaw = c.req.query("offset") ?? "0";
	const includeDeleted = c.req.query("includeDeleted") === "true";
	const limit = Number.parseInt(limitRaw, 10);
	const offset = Number.parseInt(offsetRaw, 10);

	const result = await listSources(c.env.CONTROL_DB, {
		limit: Number.isFinite(limit) ? limit : 50,
		offset: Number.isFinite(offset) ? offset : 0,
		includeDeleted,
	});

	return c.json(result);
});

app.delete("/internal/sources/:sourceId", async (c) => {
	const sourceId = c.req.param("sourceId");
	const permanent = c.req.query("permanent") === "true";

	if (permanent) {
		const deleted = await permanentlyDeleteSource(c.env.CONTROL_DB, sourceId);
		if (!deleted) {
			return c.json({ error: "Source not found or already deleted" }, 404);
		}
		return c.json({ ok: true, message: "Source permanently deleted" });
	}

	const deleted = await softDeleteSource(c.env.CONTROL_DB, sourceId);
	if (!deleted) {
		return c.json({ error: "Source not found or already deleted" }, 404);
	}
	return c.json({ ok: true, message: "Source soft-deleted" });
});

app.post("/internal/sources/:sourceId/restore", async (c) => {
	const sourceId = c.req.param("sourceId");
	const restored = await restoreSource(c.env.CONTROL_DB, sourceId);
	if (!restored) {
		return c.json({ error: "Source not found or not deleted" }, 404);
	}
	return c.json({ ok: true, message: "Source restored" });
});

app.post("/internal/sources", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = SourceConfigSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	await upsertSourceConfig(c.env.CONTROL_DB, parsed.data);
	return c.json({ ok: true, sourceId: parsed.data.sourceId }, 201);
});

app.post("/internal/sources/:sourceId/trigger", async (c) => {
	const sourceId = c.req.param("sourceId");
	const body = await c.req.json().catch(() => ({}));
	const parsed = SourceTriggerRequestSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const source = await getSourceConfigWithPolicy(c.env.CONTROL_DB, sourceId);
	if (!source) {
		return c.json({ error: "Source not found" }, 404);
	}

	if (source.config.status !== "active" && !parsed.data.force) {
		return c.json(
			{ error: `Source ${sourceId} is ${source.config.status}. Use force=true to override.` },
			409,
		);
	}

	const coordinator = getCoordinatorStub(c.env, sourceId);
	const lease = await acquireLease(coordinator, {
		requestedBy: parsed.data.triggeredBy,
		ttlSeconds: source.policy.leaseTtlSeconds,
		force: parsed.data.force,
		sourceId,
	});

	if (!lease.acquired || !lease.leaseToken) {
		return c.json({ error: lease.reason ?? "Failed to acquire lease", lease }, 409);
	}

	const instance = await c.env.COLLECTION_WORKFLOW.create({
		params: {
			sourceId,
			leaseToken: lease.leaseToken,
			triggeredBy: parsed.data.triggeredBy,
			reason: parsed.data.reason,
			force: parsed.data.force,
		},
	});

	const runId = `collect:${sourceId}:${instance.id}`;
	await insertRunIfMissing(c.env.CONTROL_DB, {
		runId,
		sourceId,
		sourceName: source.config.name,
		sourceType: source.config.type,
		status: "collecting",
		collectedAt: toIsoNow(),
		receivedAt: toIsoNow(),
		recordCount: 0,
		envelope: {
			schemaVersion: "1.0",
			ingestId: runId,
			sourceId,
			sourceName: source.config.name,
			sourceType: source.config.type,
			collectedAt: toIsoNow(),
			records: [
				{
					externalId: "placeholder",
					contentHash: "placeholder-collecting-run",
					rawPayload: { status: "collecting" },
					observedAt: toIsoNow(),
				},
			],
			hasMore: false,
			metadata: {
				placeholder: true,
			},
		},
		workflowInstanceId: instance.id,
		triggeredBy: parsed.data.triggeredBy,
	});

	return c.json(
		{
			ok: true,
			sourceId,
			runId,
			workflowId: instance.id,
			leaseExpiresAt: lease.expiresAt,
		},
		202,
	);
});

app.get("/internal/sources/:sourceId/health", async (c) => {
	const sourceId = c.req.param("sourceId");
	const source = await getSourceConfigWithPolicy(c.env.CONTROL_DB, sourceId);
	if (!source) {
		return c.json({ error: "Source not found" }, 404);
	}

	const coordinator = getCoordinatorStub(c.env, sourceId);
	const runtimeState = await getCoordinatorState(coordinator);
	await upsertRuntimeSnapshot(c.env.CONTROL_DB, runtimeState);

	const recentRuns = await c.env.CONTROL_DB.prepare(
		`SELECT run_id, status, received_at, ended_at, normalized_count, error_count
		FROM ingest_runs
		WHERE source_id = ?
		ORDER BY created_at DESC
		LIMIT 10`,
	)
		.bind(sourceId)
		.all<Record<string, unknown>>();

	return c.json({
		source: source.config,
		policy: source.policy,
		runtime: runtimeState,
		recentRuns: recentRuns.results,
	});
});

app.post("/internal/search/entities", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = EntitySearchRequestSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { query, topK, filter } = parsed.data;
	if (!c.env.AI || !c.env.ENTITY_INDEX) {
		return c.json({ error: "Vector search bindings are not configured" }, 503);
	}

	const results = await querySimilarEntities(c.env, query, {
		topK: topK ?? 10,
		filter: filter as VectorizeVectorMetadataFilter | undefined,
		returnValues: false,
		returnMetadata: true,
	});

	return c.json({
		query,
		results,
		total: results.length,
	});
});

// Alert endpoints
app.get("/internal/alerts", async (c) => {
	const severity = c.req.query("severity") as AlertSeverity | undefined;
	const alertType = c.req.query("type") as AlertType | undefined;
	const sourceId = c.req.query("sourceId") ?? undefined;
	const acknowledged = c.req.query("acknowledged");
	const limitRaw = c.req.query("limit") ?? "100";
	const limit = Number.parseInt(limitRaw, 10);

	const alerts = await listActiveAlerts(c.env.CONTROL_DB, {
		severity,
		alertType,
		sourceId,
		acknowledged: acknowledged !== undefined ? acknowledged === "true" : undefined,
		limit: Number.isFinite(limit) ? limit : 100,
	});

	return c.json({ alerts, total: alerts.length });
});

app.post("/internal/alerts/check", async (c) => {
	// Get alert configuration from all sources or use defaults
	const sourceId = c.req.query("sourceId");

	let alertConfig;
	if (sourceId) {
		// Get source-specific alert configuration
		const policyRow = await c.env.CONTROL_DB
			.prepare("SELECT alert_config_json FROM source_policies WHERE source_id = ?")
			.bind(sourceId)
			.first<{ alert_config_json: string | null }>();
		alertConfig = parseAlertConfiguration(policyRow?.alert_config_json ?? null);
	} else {
		// Use default configuration for system-wide check
		alertConfig = parseAlertConfiguration(null);
	}

	// Run all alert checks
	const result = await runAllAlertChecks(c.env.CONTROL_DB, alertConfig);

	// Auto-resolve cleared alerts
	const resolved = await autoResolveAlerts(c.env.CONTROL_DB);

	return c.json({
		ok: true,
		checksRun: result.checksRun,
		alertsCreated: result.alertsCreated,
		alertsResolved: resolved,
		errors: result.errors,
	});
});

app.post("/internal/alerts/:alertId/acknowledge", async (c) => {
	const alertId = c.req.param("alertId");
	const success = await acknowledgeAlert(c.env.CONTROL_DB, alertId);
	if (!success) {
		return c.json({ error: "Alert not found" }, 404);
	}
	return c.json({ ok: true, alertId });
});

app.post("/internal/alerts/:alertId/resolve", async (c) => {
	const alertId = c.req.param("alertId");
	const body = await c.req.json().catch(() => ({}));
	const success = await resolveAlert(c.env.CONTROL_DB, alertId, body.note);
	if (!success) {
		return c.json({ error: "Alert not found" }, 404);
	}
	return c.json({ ok: true, alertId });
});

// Metrics endpoints
app.get("/internal/metrics/system", async (c) => {
	const metrics = await getSystemMetrics(c.env.CONTROL_DB);
	return c.json(metrics);
});

app.get("/internal/metrics/sources", async (c) => {
	const windowRaw = c.req.query("window") ?? "3600";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const metrics = await getAllSourceMetrics(
		c.env.CONTROL_DB,
		Number.isFinite(windowSeconds) ? windowSeconds : 3600,
	);
	return c.json({ sources: metrics, total: metrics.length });
});

app.get("/internal/metrics/sources/:sourceId", async (c) => {
	const sourceId = c.req.param("sourceId");
	const windowRaw = c.req.query("window") ?? "3600";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const metrics = await getPerSourceMetrics(
		c.env.CONTROL_DB,
		sourceId,
		Number.isFinite(windowSeconds) ? windowSeconds : 3600,
	);
	if (!metrics) {
		return c.json({ error: "Source not found or no data" }, 404);
	}
	return c.json(metrics);
});

app.get("/internal/metrics/queue", async (c) => {
	const metrics = await getQueueMetrics(c.env.CONTROL_DB);
	return c.json(metrics);
});

app.get("/internal/metrics/entities", async (c) => {
	const metrics = await getEntityMetrics(c.env.CONTROL_DB);
	return c.json(metrics);
});

// Error recovery endpoints
app.get("/internal/errors", async (c) => {
	const queryParams = {
		status: c.req.query("status") ?? undefined,
		sourceId: c.req.query("sourceId") ?? undefined,
		phase: c.req.query("phase") ?? undefined,
		errorCategory: c.req.query("errorCategory") ?? undefined,
		fromDate: c.req.query("fromDate") ?? undefined,
		toDate: c.req.query("toDate") ?? undefined,
		limit: c.req.query("limit") ?? "50",
		offset: c.req.query("offset") ?? "0",
	};

	const parsed = ErrorFilterSchema.safeParse({
		...queryParams,
		limit: Number.parseInt(queryParams.limit, 10),
		offset: Number.parseInt(queryParams.offset, 10),
	});

	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const result = await listIngestErrors(c.env.CONTROL_DB, parsed.data);

	return c.json({
		errors: result.errors,
		total: result.total,
		limit: parsed.data.limit,
		offset: parsed.data.offset,
		hasMore: result.total > (parsed.data.offset ?? 0) + (parsed.data.limit ?? 50),
	});
});

app.post("/internal/errors/:errorId/retry", async (c) => {
	const errorId = c.req.param("errorId");
	const body = await c.req.json().catch(() => ({}));
	const parsed = ErrorRetryRequestSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const result = await retryFailedOperation(c.env, errorId, {
		force: parsed.data.force,
		triggeredBy: parsed.data.triggeredBy,
	});

	const statusCode = result.success ? 200 : result.newStatus === "dead_letter" ? 409 : 422;

	return c.json(result, statusCode);
});

// Production monitoring dashboard endpoint
app.get("/internal/dashboard", async (c) => {
	const [
		systemMetrics,
		queueMetrics,
		entityMetrics,
		sources,
		alerts,
	] = await Promise.all([
		getSystemMetrics(c.env.CONTROL_DB),
		getQueueMetrics(c.env.CONTROL_DB),
		getEntityMetrics(c.env.CONTROL_DB),
		c.env.CONTROL_DB.prepare("SELECT source_id, name, type, status FROM source_configs LIMIT 100").all(),
		listActiveAlerts(c.env.CONTROL_DB, { limit: 10 }),
	]);

	// Get recent runs summary
	const recentRuns = await c.env.CONTROL_DB
		.prepare(`
			SELECT status, COUNT(*) as count
			FROM ingest_runs
			WHERE created_at > unixepoch() - 86400
			GROUP BY status
		`)
		.all();

	const runSummary: Record<string, number> = {};
	for (const row of recentRuns.results ?? []) {
		const status = (row as { status: string; count: number }).status;
		const count = (row as { status: string; count: number }).count;
		runSummary[status] = count;
	}

	return c.json({
		timestamp: toIsoNow(),
		summary: {
			sources: {
				total: sources.results?.length ?? 0,
				active: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "active").length,
				paused: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "paused").length,
			},
			runs24h: runSummary,
			alerts: {
				active: alerts.length,
				critical: alerts.filter(a => a.severity === "critical").length,
			},
		},
		system: systemMetrics,
		queue: queueMetrics,
		entities: entityMetrics,
		activeAlerts: alerts.slice(0, 5),
	});
});

// Browser manager status endpoint
app.get("/internal/browser/status", async (c) => {
	const managerStub = getBrowserManagerStub(c.env);
	const response = await managerStub.fetch("https://browser-manager/status");
	
	if (!response.ok) {
		return c.json({ error: "Failed to get browser manager status" }, 502);
	}
	
	const status = await response.json();
	return c.json(status);
});

// Notification test endpoints
app.post("/internal/notifications/test/:channel", async (c) => {
	const channel = c.req.param("channel") as "webhook" | "slack";
	const body = await c.req.json().catch(() => ({}));
	const result = await testNotificationChannel(c.env, channel, body.url);
	return c.json(result, result.success ? 200 : 400);
});

// ============ HEALTH MONITORING & VISUAL PIPELINE ============

// Get component health status
app.get("/internal/health/components", async (c) => {
	const components = await getComponentHealth(c.env);
	return c.json({ components, timestamp: toIsoNow() });
});

// Get pipeline topology with flow rates
app.get("/internal/health/topology", async (c) => {
	const topology = await getPipelineTopology(c.env, c.env.CONTROL_DB);
	return c.json(topology);
});

// Get data flow metrics
app.get("/internal/health/flow", async (c) => {
	const windowRaw = c.req.query("window") ?? "3600";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const metrics = await getDataFlowMetrics(
		c.env.CONTROL_DB,
		Number.isFinite(windowSeconds) ? windowSeconds : 3600,
	);
	return c.json(metrics);
});

// Get source health timeline
app.get("/internal/sources/:sourceId/health/timeline", async (c) => {
	const sourceId = c.req.param("sourceId");
	const windowRaw = c.req.query("window") ?? "3600";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const timeline = await getSourceHealthTimeline(
		c.env.CONTROL_DB,
		sourceId,
		Number.isFinite(windowSeconds) ? windowSeconds : 3600,
	);
	return c.json(timeline);
});

// ============ SETTINGS & CONFIGURATION ============

// Get platform settings
app.get("/internal/settings", async (c) => {
	const settings = await getSettings(c.env);
	return c.json(settings);
});

// Update platform settings
app.put("/internal/settings", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const actor = c.req.header("x-actor-id") ?? "system";
	
	const updated = await saveSettings(c.env, body, actor);
	
	await logAuditEvent(c.env.CONTROL_DB, {
		action: "settings.update",
		actor,
		resourceType: "settings",
		details: { changedFields: Object.keys(body) },
	});
	
	return c.json(updated);
});

// ============ AUDIT LOG ============

// Get audit log
app.get("/internal/audit-log", async (c) => {
	const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const resourceType = c.req.query("resourceType") ?? undefined;
	const actor = c.req.query("actor") ?? undefined;
	const fromDate = c.req.query("fromDate") ?? undefined;
	const toDate = c.req.query("toDate") ?? undefined;
	
	const result = await getAuditLog(c.env.CONTROL_DB, {
		limit: Number.isFinite(limit) ? limit : 50,
		offset: Number.isFinite(offset) ? offset : 0,
		resourceType,
		actor,
		fromDate,
		toDate,
	});
	
	return c.json(result);
});

// ============ TRACING & LINEAGE ============

// Get run trace (full run history with children, errors, artifacts)
app.get("/internal/runs/:runId/trace", async (c) => {
	const runId = c.req.param("runId");
	const trace = await getRunTrace(c.env.CONTROL_DB, runId);
	
	if (!trace) {
		return c.json({ error: "Run not found" }, 404);
	}
	
	return c.json(trace);
});

// Get entity lineage
app.get("/internal/entities/:entityId/lineage", async (c) => {
	const entityId = c.req.param("entityId");
	const lineage = await getEntityLineage(c.env.CONTROL_DB, entityId);
	
	if (!lineage) {
		return c.json({ error: "Entity not found" }, 404);
	}
	
	return c.json(lineage);
});

// Get source run tree (hierarchy of runs and replays)
app.get("/internal/sources/:sourceId/runs/tree", async (c) => {
	const sourceId = c.req.param("sourceId");
	const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const tree = await getSourceRunTree(
		c.env.CONTROL_DB,
		sourceId,
		Number.isFinite(limit) ? limit : 50,
	);
	return c.json(tree);
});

// ============ ENHANCED DASHBOARD V2 ============

app.get("/internal/dashboard/v2", async (c) => {
	const windowRaw = c.req.query("window") ?? "86400";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const effectiveWindow = Number.isFinite(windowSeconds) ? windowSeconds : 86400;
	
	const [
		systemMetrics,
		queueMetrics,
		entityMetrics,
		pipelineTopology,
		components,
		sources,
		alerts,
		recentRuns,
	] = await Promise.all([
		getSystemMetrics(c.env.CONTROL_DB),
		getQueueMetrics(c.env.CONTROL_DB),
		getEntityMetrics(c.env.CONTROL_DB),
		getPipelineTopology(c.env, c.env.CONTROL_DB),
		getComponentHealth(c.env),
		c.env.CONTROL_DB.prepare("SELECT source_id, name, type, status FROM source_configs WHERE deleted_at IS NULL LIMIT 100").all(),
		listActiveAlerts(c.env.CONTROL_DB, { limit: 10 }),
		c.env.CONTROL_DB.prepare(`
			SELECT status, COUNT(*) as count
			FROM ingest_runs
			WHERE created_at > unixepoch() - ?
			GROUP BY status
		`).bind(effectiveWindow).all(),
	]);
	
	const runSummary: Record<string, number> = {};
	for (const row of recentRuns.results ?? []) {
		const status = (row as { status: string; count: number }).status;
		const count = (row as { status: string; count: number }).count;
		runSummary[status] = count;
	}
	
	// Calculate trends (compare with previous window)
	const previousWindowStart = Math.floor(Date.now() / 1000) - effectiveWindow * 2;
	const previousWindowEnd = Math.floor(Date.now() / 1000) - effectiveWindow;
	
	const previousRuns = await c.env.CONTROL_DB.prepare(`
		SELECT COUNT(*) as count FROM ingest_runs
		WHERE created_at >= ? AND created_at < ?
	`).bind(previousWindowStart, previousWindowEnd).first<{ count: number }>();
	
	const currentTotal = Object.values(runSummary).reduce((a, b) => a + b, 0);
	const previousTotal = previousRuns?.count ?? 0;
	const runTrend = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;
	
	return c.json({
		timestamp: toIsoNow(),
		windowSeconds: effectiveWindow,
		summary: {
			sources: {
				total: sources.results?.length ?? 0,
				active: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "active").length,
				paused: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "paused").length,
				degraded: components.filter(c => c.status === "degraded").length,
			},
			runs: {
				current: runSummary,
				trend: {
					percentage: Math.round(runTrend),
					direction: runTrend >= 0 ? "up" : "down",
				},
			},
			alerts: {
				active: alerts.length,
				critical: alerts.filter(a => a.severity === "critical").length,
				warning: alerts.filter(a => a.severity === "warning").length,
			},
		},
		pipeline: pipelineTopology,
		components: components.map(c => ({
			id: c.id,
			name: c.name,
			status: c.status,
			latencyMs: c.latencyMs,
		})),
		system: systemMetrics,
		queue: queueMetrics,
		entities: entityMetrics,
		activeAlerts: alerts.slice(0, 5).map(a => ({
			alertId: a.alertId,
			alertType: a.alertType,
			severity: a.severity,
			message: a.message,
			sourceId: a.sourceId,
			createdAt: a.createdAt,
		})),
	});
});

// ============ INTERACTIVE HTML DASHBOARD ============

app.get("/dashboard", async (c) => {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Uplink Connect - System Dashboard</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background: #0f172a;
			color: #e2e8f0;
			line-height: 1.6;
		}
		.container { max-width: 1400px; margin: 0 auto; padding: 20px; }
		header {
			background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
			padding: 30px;
			border-radius: 12px;
			margin-bottom: 30px;
			border: 1px solid #475569;
		}
		header h1 {
			font-size: 2rem;
			background: linear-gradient(90deg, #60a5fa, #a78bfa);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
			margin-bottom: 10px;
		}
		.status-badge {
			display: inline-block;
			padding: 6px 12px;
			border-radius: 20px;
			font-size: 0.875rem;
			font-weight: 600;
			text-transform: uppercase;
		}
		.status-healthy { background: #065f46; color: #34d399; }
		.status-degraded { background: #92400e; color: #fbbf24; }
		.status-unhealthy { background: #991b1b; color: #f87171; }
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
			gap: 20px;
			margin-bottom: 30px;
		}
		.card {
			background: #1e293b;
			border-radius: 12px;
			padding: 24px;
			border: 1px solid #334155;
		}
		.card h3 {
			color: #94a3b8;
			font-size: 0.875rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-bottom: 12px;
		}
		.metric {
			font-size: 2.5rem;
			font-weight: 700;
			color: #f8fafc;
		}
		.metric-sub {
			font-size: 0.875rem;
			color: #64748b;
			margin-top: 4px;
		}
		.trend-up { color: #34d399; }
		.trend-down { color: #f87171; }
		.pipeline {
			display: flex;
			align-items: center;
			gap: 10px;
			margin: 20px 0;
			flex-wrap: wrap;
		}
		.stage {
			background: #334155;
			padding: 16px 24px;
			border-radius: 8px;
			text-align: center;
			min-width: 120px;
			border: 2px solid transparent;
		}
		.stage.healthy { border-color: #34d399; }
		.stage.degraded { border-color: #fbbf24; }
		.stage.unhealthy { border-color: #f87171; }
		.stage-name { font-weight: 600; margin-bottom: 4px; }
		.stage-rate { font-size: 0.75rem; color: #94a3b8; }
		.arrow {
			color: #64748b;
			font-size: 1.5rem;
		}
		.alerts {
			margin-top: 20px;
		}
		.alert-item {
			background: #334155;
			padding: 16px;
			border-radius: 8px;
			margin-bottom: 12px;
			border-left: 4px solid;
		}
		.alert-item.critical { border-left-color: #f87171; }
		.alert-item.warning { border-left-color: #fbbf24; }
		.alert-title { font-weight: 600; margin-bottom: 4px; }
		.alert-meta { font-size: 0.875rem; color: #64748b; }
		.components {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
			gap: 12px;
			margin-top: 20px;
		}
		.component {
			background: #334155;
			padding: 16px;
			border-radius: 8px;
			display: flex;
			align-items: center;
			gap: 12px;
		}
		.component-icon {
			width: 40px;
			height: 40px;
			border-radius: 8px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 1.25rem;
		}
		.component-info { flex: 1; }
		.component-name { font-weight: 600; font-size: 0.875rem; }
		.component-status { font-size: 0.75rem; color: #64748b; }
		.refresh-btn {
			background: #3b82f6;
			color: white;
			border: none;
			padding: 12px 24px;
			border-radius: 8px;
			cursor: pointer;
			font-weight: 600;
			margin-top: 20px;
		}
		.refresh-btn:hover { background: #2563eb; }
		.loading {
			text-align: center;
			padding: 40px;
			color: #64748b;
		}
		.error {
			background: #991b1b;
			color: #f87171;
			padding: 16px;
			border-radius: 8px;
			margin: 20px 0;
		}
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>Uplink Connect</h1>
			<p>Data Ingestion Platform Dashboard</p>
			<span id="overall-status" class="status-badge status-healthy">Loading...</span>
		</header>

		<div id="content">
			<div class="loading">Loading dashboard data...</div>
		</div>

		<button class="refresh-btn" onclick="loadDashboard()">Refresh Dashboard</button>
	</div>

	<script>
		async function loadDashboard() {
			const content = document.getElementById('content');
			const statusBadge = document.getElementById('overall-status');
			
			content.innerHTML = '<div class="loading">Loading dashboard data...</div>';
			
			try {
				const response = await fetch('/internal/dashboard/v2?window=86400');
				if (!response.ok) throw new Error('Failed to load dashboard');
				const data = await response.json();
				
				// Update overall status
				const overallStatus = data.pipeline?.overallHealth || 'unknown';
				statusBadge.className = 'status-badge status-' + overallStatus;
				statusBadge.textContent = overallStatus;
				
				// Build dashboard HTML
				content.innerHTML = \`
					<div class="grid">
						<div class="card">
							<h3>Total Sources</h3>
							<div class="metric">\${data.summary.sources.total}</div>
							<div class="metric-sub">
								<span class="trend-up">\${data.summary.sources.active} active</span> · 
								\${data.summary.sources.paused} paused
							</div>
						</div>
						<div class="card">
							<h3>Runs (24h)</h3>
							<div class="metric">\${Object.values(data.summary.runs.current).reduce((a,b)=>a+b,0)}</div>
							<div class="metric-sub">
								<span class="\${data.summary.runs.trend.direction === 'up' ? 'trend-up' : 'trend-down'}">
									\${data.summary.runs.trend.direction === 'up' ? '↑' : '↓'} \${Math.abs(data.summary.runs.trend.percentage)}%
								</span> vs previous period
							</div>
						</div>
						<div class="card">
							<h3>Queue Lag</h3>
							<div class="metric">\${Math.round(data.queue.queueLagSeconds / 60)}m</div>
							<div class="metric-sub">\${data.queue.pendingCount} pending · \${data.queue.processingCount} processing</div>
						</div>
						<div class="card">
							<h3>Active Alerts</h3>
							<div class="metric">\${data.summary.alerts.active}</div>
							<div class="metric-sub">
								<span class="trend-down">\${data.summary.alerts.critical} critical</span> · 
								\${data.summary.alerts.warning} warning
							</div>
						</div>
					</div>

					<div class="card">
						<h3>Data Pipeline Flow</h3>
						<div class="pipeline">
							\${data.pipeline?.stages.map(stage => \`
								<div class="stage \${stage.status}">
									<div class="stage-name">\${stage.name}</div>
									<div class="stage-rate">\${stage.outputRate ? stage.outputRate + '/hr' : 'N/A'}</div>
								</div>
							\`).join('<span class="arrow">→</span>')}
						</div>
					</div>

					<div class="grid">
						<div class="card">
							<h3>Component Health</h3>
							<div class="components">
								\${data.components?.map(comp => \`
									<div class="component">
										<div class="component-icon" style="background: \${comp.status === 'healthy' ? '#065f46' : comp.status === 'degraded' ? '#92400e' : '#991b1b'}">
											\${comp.status === 'healthy' ? '✓' : comp.status === 'degraded' ? '!' : '✗'}
										</div>
										<div class="component-info">
											<div class="component-name">\${comp.name}</div>
											<div class="component-status">\${comp.status}\${comp.latencyMs ? ' · ' + comp.latencyMs + 'ms' : ''}</div>
										</div>
									</div>
								\`).join('')}
							</div>
						</div>

						<div class="card">
							<h3>Active Alerts</h3>
							<div class="alerts">
								\${data.activeAlerts?.length > 0 
									? data.activeAlerts.map(alert => \`
										<div class="alert-item \${alert.severity}">
											<div class="alert-title">\${alert.message}</div>
											<div class="alert-meta">\${alert.alertType} · \${new Date(alert.createdAt * 1000).toLocaleString()}</div>
										</div>
									\`).join('')
									: '<div style="color: #64748b; padding: 20px;">No active alerts</div>'
								}
							</div>
						</div>
					</div>
				\`;
			} catch (error) {
				content.innerHTML = \`<div class="error">Error loading dashboard: \${error.message}</div>\`;
			}
		}

		// Load on page load
		loadDashboard();
		
		// Auto-refresh every 30 seconds
		setInterval(loadDashboard, 30000);
	</script>
</body>
</html>`;
	
	return c.html(html);
});

export default {
	async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, executionCtx);
	},

	async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
		await processQueueBatch(batch, env);
	},
};

export { SourceCoordinator, BrowserManagerDO, CollectionWorkflow, RetentionWorkflow };
