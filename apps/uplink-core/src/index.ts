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
} from "./lib/db";
import { processQueueBatch, retryFailedOperation } from "./lib/processing";
import { querySimilarEntities } from "./lib/vectorize";
import type { VectorizeVectorMetadataFilter } from "./lib/vectorize";
import { SourceCoordinator } from "./durable/source-coordinator";
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
	const limit = Number.parseInt(limitRaw, 10);
	const runs = await listRuns(c.env.CONTROL_DB, Number.isFinite(limit) ? limit : 50);
	return c.json({ runs, total: runs.length });
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
	const result = await c.env.CONTROL_DB.prepare(
		`SELECT source_id, name, type, status, adapter_type, endpoint_url, updated_at
		FROM source_configs
		ORDER BY updated_at DESC`,
	).all<Record<string, unknown>>();

	return c.json({ sources: result.results, total: result.results.length });
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

export default {
	async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, executionCtx);
	},

	async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
		await processQueueBatch(batch, env);
	},
};

export { SourceCoordinator, CollectionWorkflow, RetentionWorkflow };
