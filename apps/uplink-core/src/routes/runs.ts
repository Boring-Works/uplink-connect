import { Hono } from "hono";
import type { Env } from "../types";
import { IngestEnvelopeSchema, createIngestQueueMessage, toIsoNow } from "@uplink/contracts";
import { getRun, listRuns, insertRunIfMissing } from "../lib/db";
import { getRunTrace } from "../lib/tracing";

const app = new Hono<{ Bindings: Env }>();

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
	if (["received", "collecting", "enqueued", "persisted", "replayed"].includes(runStatus)) {
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

app.get("/internal/runs/:runId/trace", async (c) => {
	const runId = c.req.param("runId");
	const trace = await getRunTrace(c.env.CONTROL_DB, runId);

	if (!trace) {
		return c.json({ error: "Run not found" }, 404);
	}

	return c.json(trace);
});

export default app;
