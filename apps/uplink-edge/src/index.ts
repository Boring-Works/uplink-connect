import { Hono } from "hono";
import {
	IngestEnvelopeSchema,
	createIngestQueueMessage,
	toIsoNow,
	verifyWebhookSignature,
	timingSafeEqual,
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

app.get("/health", async (c) => {
	const checks: Array<{ name: string; status: "healthy" | "degraded" | "unhealthy"; error?: string }> = [];

	// Check queue binding
	try {
		// We can't easily probe a Queue without sending, but we can verify the binding exists
		if (!c.env.INGEST_QUEUE) {
			checks.push({ name: "ingest-queue", status: "unhealthy", error: "Queue binding missing" });
		} else {
			checks.push({ name: "ingest-queue", status: "healthy" });
		}
	} catch (err) {
		checks.push({ name: "ingest-queue", status: "unhealthy", error: err instanceof Error ? err.message : String(err) });
	}

	// Check R2 binding
	try {
		if (!c.env.RAW_BUCKET) {
			checks.push({ name: "raw-bucket", status: "degraded", error: "Binding missing" });
		} else {
			await c.env.RAW_BUCKET.head("health-check");
			checks.push({ name: "raw-bucket", status: "healthy" });
		}
	} catch (err) {
		checks.push({ name: "raw-bucket", status: "degraded", error: err instanceof Error ? err.message : "R2 head failed" });
	}

	// Check uplink-core reachability
	try {
		const coreRes = await c.env.UPLINK_CORE.fetch("https://uplink-core/health");
		checks.push({ name: "uplink-core", status: coreRes.ok ? "healthy" : "degraded" });
	} catch (err) {
		checks.push({ name: "uplink-core", status: "unhealthy", error: err instanceof Error ? err.message : String(err) });
	}

	const unhealthy = checks.filter((x) => x.status === "unhealthy").length;
	const degraded = checks.filter((x) => x.status === "degraded").length;
	const overall = unhealthy > 0 ? "unhealthy" : degraded > 0 ? "degraded" : "healthy";

	return c.json({
		ok: overall === "healthy",
		service: "uplink-edge",
		status: overall,
		checks,
		now: toIsoNow(),
	});
});

app.post("/v1/intake", async (c) => {
	if (!c.env.INGEST_API_KEY) {
		return c.json({ error: "INGEST_API_KEY not configured" }, 500);
	}

	if (!isAuthorized(c.req.raw, c.env.INGEST_API_KEY)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
	if (contentLength > 10 * 1024 * 1024) {
		return c.json({ error: "Payload too large", maxBytes: 10 * 1024 * 1024 }, 413);
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

	try {
		await c.env.INGEST_QUEUE.send(queueMessage);
	} catch (err) {
		return c.json(
			{
				error: "Failed to enqueue message",
				detail: err instanceof Error ? err.message : "Unknown error",
			},
			503,
		);
	}

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
	if (!c.env.INGEST_API_KEY) {
		return c.json({ error: "INGEST_API_KEY not configured" }, 500);
	}

	if (!isAuthorized(c.req.raw, c.env.INGEST_API_KEY)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const sourceId = c.req.param("sourceId");
	const bodyText = await c.req.text();

	if (!c.env.CORE_INTERNAL_KEY) {
		return c.json({ error: "CORE_INTERNAL_KEY not configured" }, 500);
	}

	// Fetch source config to check webhook security settings
	let sourceResponse: Response;
	try {
		sourceResponse = await c.env.UPLINK_CORE.fetch(
			`https://uplink-core/internal/sources/${encodeURIComponent(sourceId)}`,
			{
				headers: {
					"x-uplink-internal-key": c.env.CORE_INTERNAL_KEY,
				},
			},
		);
	} catch (err) {
		return c.json({ error: "Upstream unavailable", detail: err instanceof Error ? err.message : String(err) }, 503);
	}

	if (sourceResponse.status === 404) {
		return c.json({ error: "Source not found" }, 404);
	}
	if (!sourceResponse.ok) {
		return c.json({ error: "Upstream error" }, 502);
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
	} else {
		return c.json({ error: "Webhook secret not configured" }, 400);
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

	try {
		await c.env.INGEST_QUEUE.send(queueMessage);
	} catch (err) {
		return c.json(
			{
				error: "Failed to enqueue message",
				detail: err instanceof Error ? err.message : "Unknown error",
			},
			503,
		);
	}

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

	const MAX_FILES = 10;
	const MAX_FILE_SIZE = 50 * 1024 * 1024;

	if (files.length > MAX_FILES) {
		return c.json({ error: "Too many files", maxFiles: MAX_FILES }, 413);
	}

	if (!c.env.RAW_BUCKET) {
		return c.json({ error: "RAW_BUCKET not configured" }, 500);
	}

	const results: Array<{ fileName: string; ingestId: string; size: number; key: string }> = [];
	const failed: Array<{ fileName: string; reason: string }> = [];

	for (const file of files) {
		if (!(file instanceof File)) {
			continue;
		}

		if (file.size > MAX_FILE_SIZE) {
			failed.push({ fileName: file.name, reason: "File too large" });
			continue;
		}

		const ingestId = crypto.randomUUID();
		const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
		const key = `uploads/${sourceId}/${ingestId}/${safeName}`;
		const buffer = await file.arrayBuffer();

		try {
			await c.env.RAW_BUCKET.put(key, buffer, {
				httpMetadata: { contentType: file.type || "application/octet-stream" },
				customMetadata: {
					sourceId,
					fileName: safeName,
					ingestId,
					uploadedAt: toIsoNow(),
				},
			});
		} catch (err) {
			failed.push({ fileName: file.name, reason: err instanceof Error ? err.message : "R2 upload failed" });
			continue;
		}

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
					externalId: safeName,
					contentHash,
					rawPayload: {
						fileName: safeName,
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

		try {
			await c.env.INGEST_QUEUE.send(queueMessage);
		} catch (err) {
			failed.push({ fileName: file.name, reason: err instanceof Error ? err.message : "Queue enqueue failed" });
			continue;
		}

		results.push({ fileName: safeName, ingestId, size: file.size, key });
	}

	return c.json(
		{
			ok: failed.length === 0,
			sourceId,
			uploaded: results.length,
			failed: failed.length,
			files: results,
			errors: failed.length > 0 ? failed : undefined,
		},
		failed.length > 0 && results.length === 0 ? 503 : 202,
	);
});

app.post("/v1/sources/:sourceId/trigger", async (c) => {
	if (!c.env.INGEST_API_KEY) {
		return c.json({ error: "INGEST_API_KEY not configured" }, 500);
	}

	if (!isAuthorized(c.req.raw, c.env.INGEST_API_KEY)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	if (!c.env.CORE_INTERNAL_KEY) {
		return c.json({ error: "CORE_INTERNAL_KEY not configured" }, 500);
	}

	const sourceId = c.req.param("sourceId");
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const response = await c.env.UPLINK_CORE.fetch(new URL("/internal/sources/" + encodeURIComponent(sourceId) + "/trigger", c.req.url).toString(), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-uplink-internal-key": c.env.CORE_INTERNAL_KEY,
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
