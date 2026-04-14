import { Hono } from "hono";
import type { Env } from "../types";
import { SourceConfigSchema, SourceTriggerRequestSchema, toIsoNow } from "@uplink/contracts";
import {
	getSourceConfigWithPolicy,
	insertRunIfMissing,
	upsertRuntimeSnapshot,
	upsertSourceConfig,
	softDeleteSource,
	restoreSource,
	permanentlyDeleteSource,
	listSources,
} from "../lib/db";
import {
	acquireLease,
	getCoordinatorState,
	getCoordinatorStub,
} from "../lib/coordinator-client";
import { getSourceRunTree } from "../lib/tracing";

const app = new Hono<{ Bindings: Env }>();

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

export default app;
