import { Hono } from "hono";
import {
	IngestEnvelopeSchema,
	createIngestQueueMessage,
	toIsoNow,
	verifyWebhookSignature,
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

app.post("/v1/webhooks/:sourceId", async (c) => {
	const sourceId = c.req.param("sourceId");
	const bodyText = await c.req.text();

	// Fetch source config to check webhook security settings
	const sourceResponse = await c.env.UPLINK_CORE.fetch(
		`https://uplink-core/internal/sources/${sourceId}`,
		{
			headers: {
				"x-uplink-internal-key": c.env.CORE_INTERNAL_KEY ?? "",
			},
		},
	);

	if (!sourceResponse.ok) {
		return c.json({ error: "Source not found" }, 404);
	}

	const source = await sourceResponse.json() as {
		type: string;
		webhookSecurity?: {
			secret?: string;
			signatureHeader?: string;
			signatureAlgorithm?: "hmac-sha256" | "hmac-sha512";
		};
	};

	if (source.type !== "webhook") {
		return c.json({ error: "Source is not configured for webhooks" }, 400);
	}

	// Verify HMAC signature if configured
	if (source.webhookSecurity?.secret) {
		const signatureHeader = source.webhookSecurity.signatureHeader ?? "x-webhook-signature";
		const signature = c.req.header(signatureHeader) ?? "";
		const isValid = await verifyWebhookSignature(
			bodyText,
			signature,
			source.webhookSecurity.secret,
			source.webhookSecurity.signatureAlgorithm ?? "hmac-sha256",
		);
		if (!isValid) {
			return c.json({ error: "Invalid webhook signature" }, 401);
		}
	}

	let payload: unknown;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		payload = { rawBody: bodyText };
	}

	const envelope = {
		schemaVersion: "1.0" as const,
		ingestId: crypto.randomUUID(),
		sourceId,
		sourceName: sourceId,
		sourceType: "webhook" as const,
		collectedAt: toIsoNow(),
		records: [{
			contentHash: await computeContentHash(bodyText),
			rawPayload: payload,
		}],
	};

	const queueMessage = createIngestQueueMessage(envelope, {
		requestId: c.req.header("cf-ray") ?? c.req.header("x-request-id") ?? crypto.randomUUID(),
	});

	await c.env.INGEST_QUEUE.send(queueMessage);

	return c.json(
		{
			ok: true,
			ingestId: envelope.ingestId,
			sourceId,
			recordCount: 1,
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

async function computeContentHash(text: string): Promise<string> {
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export default app;
