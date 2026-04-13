import { Hono } from "hono";
import {
	IngestEnvelopeSchema,
	createIngestQueueMessage,
	toIsoNow,
	type IngestEnvelope,
} from "@uplink/contracts";

type Env = {
	INGEST_QUEUE: Queue;
	UPLINK_CORE: Fetcher;
	INGEST_API_KEY?: string;
	CORE_INTERNAL_KEY?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "uplink-edge", now: toIsoNow() }));

app.post("/v1/intake", async (c) => {
	if (!c.env.INGEST_API_KEY) {
		return c.json({ error: "INGEST_API_KEY not configured" }, 500);
	}

	if (!isAuthorized(c.req.raw, c.env.INGEST_API_KEY)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	let payload: unknown;
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON payload" }, 400);
	}

	const parsed = IngestEnvelopeSchema.safeParse(ensureDefaults(payload));
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const envelope = parsed.data;
	const queueMessage = createIngestQueueMessage(envelope, {
		requestId: c.req.header("cf-ray") ?? c.req.header("x-request-id"),
	});

	await c.env.INGEST_QUEUE.send(queueMessage);

	return c.json(
		{
			ok: true,
			ingestId: envelope.ingestId,
			sourceId: envelope.sourceId,
			recordCount: envelope.records.length,
			receivedAt: queueMessage.receivedAt,
		},
		202,
	);
});

app.post("/v1/sources/:sourceId/trigger", async (c) => {
	if (!c.env.INGEST_API_KEY) {
		return c.json({ error: "INGEST_API_KEY not configured" }, 500);
	}

	if (!isAuthorized(c.req.raw, c.env.INGEST_API_KEY)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const sourceId = c.req.param("sourceId");
	const body = await c.req.json().catch(() => ({}));

	const response = await c.env.UPLINK_CORE.fetch("https://uplink-core/internal/sources/" + sourceId + "/trigger", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-uplink-internal-key": c.env.CORE_INTERNAL_KEY ?? "",
		},
		body: JSON.stringify({ ...body, triggeredBy: "edge" }),
	});

	return response;
});

function ensureDefaults(payload: unknown): IngestEnvelope {
	const incoming = (payload ?? {}) as Partial<IngestEnvelope>;

	return {
		schemaVersion: "1.0",
		ingestId: incoming.ingestId ?? crypto.randomUUID(),
		sourceId: incoming.sourceId ?? "",
		sourceName: incoming.sourceName ?? "",
		sourceType: incoming.sourceType ?? "api",
		collectedAt: incoming.collectedAt ?? toIsoNow(),
		records: incoming.records ?? [],
		hasMore: incoming.hasMore ?? false,
		nextCursor: incoming.nextCursor,
		traceId: incoming.traceId,
		collectionDurationMs: incoming.collectionDurationMs,
		externalRequestId: incoming.externalRequestId,
		metadata: incoming.metadata,
	};
}

function isAuthorized(request: Request, apiKey: string): boolean {
	const authHeader = request.headers.get("authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return false;
	}
	const token = authHeader.slice("Bearer ".length);
	return token.length > 0 && token === apiKey;
}

export default app;
