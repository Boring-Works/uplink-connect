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
	RAW_BUCKET?: R2Bucket;
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
				"x-uplink-internal-key": c.env.CORE_INTERNAL_KEY || "missing",
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
		hasMore: false,
		records: [{
			contentHash: await computeTextHash(bodyText),
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

app.post("/v1/files/:sourceId", async (c) => {
	if (!c.env.INGEST_API_KEY) {
		return c.json({ error: "INGEST_API_KEY not configured" }, 500);
	}

	if (!isAuthorized(c.req.raw, c.env.INGEST_API_KEY)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const sourceId = c.req.param("sourceId");
	const contentType = c.req.header("content-type") ?? "";

	if (!contentType.includes("multipart/form-data")) {
		return c.json({ error: "Expected multipart/form-data" }, 400);
	}

	const formData = await c.req.formData();
	const files = formData.getAll("file");

	if (files.length === 0) {
		return c.json({ error: "No files provided. Use 'file' field name." }, 400);
	}

	if (!c.env.RAW_BUCKET) {
		return c.json({ error: "RAW_BUCKET not configured" }, 500);
	}

	const results: Array<{ fileName: string; ingestId: string; size: number; key: string }> = [];

	for (const file of files) {
		if (!(file instanceof File)) {
			continue;
		}

		const ingestId = crypto.randomUUID();
		const key = `uploads/${sourceId}/${ingestId}/${file.name}`;
		const buffer = await file.arrayBuffer();

		await c.env.RAW_BUCKET.put(key, buffer, {
			httpMetadata: { contentType: file.type || "application/octet-stream" },
			customMetadata: {
				sourceId,
				fileName: file.name,
				ingestId,
				uploadedAt: toIsoNow(),
			},
		});

		const contentHash = await computeBufferHash(buffer);

		const envelope: IngestEnvelope = {
			schemaVersion: "1.0",
			ingestId,
			sourceId,
			sourceName: sourceId,
			sourceType: "file",
			collectedAt: toIsoNow(),
			hasMore: false,
			records: [
				{
					externalId: file.name,
					contentHash,
					rawPayload: {
						fileName: file.name,
						contentType: file.type || "application/octet-stream",
						size: file.size,
						r2Key: key,
					},
					observedAt: toIsoNow(),
				},
			],
		};

		const queueMessage = createIngestQueueMessage(envelope, {
			requestId: c.req.header("x-request-id") ?? crypto.randomUUID(),
		});

		await c.env.INGEST_QUEUE.send(queueMessage);

		results.push({ fileName: file.name, ingestId, size: file.size, key });
	}

	return c.json(
		{
			ok: true,
			sourceId,
			uploaded: results.length,
			files: results,
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

	const response = await c.env.UPLINK_CORE.fetch(new URL("/internal/sources/" + sourceId + "/trigger", c.req.url).toString(), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-uplink-internal-key": c.env.CORE_INTERNAL_KEY || "missing",
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
		sourceId: incoming.sourceId ?? "unknown",
		sourceName: incoming.sourceName ?? "Unknown Source",
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

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		const dummy = "\0".repeat(a.length);
		let result = 0;
		for (let i = 0; i < a.length; i++) {
			result |= a.charCodeAt(i) ^ dummy.charCodeAt(i);
		}
		return result === 0;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

function isAuthorized(request: Request, apiKey: string): boolean {
	const authHeader = request.headers.get("authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return false;
	}
	const token = authHeader.slice("Bearer ".length);
	return token.length > 0 && timingSafeEqual(token, apiKey);
}

async function computeBufferHash(buffer: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function computeTextHash(text: string): Promise<string> {
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export default app;
