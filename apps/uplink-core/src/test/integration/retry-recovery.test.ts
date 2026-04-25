import { describe, expect, it } from "vitest";
import { createIngestQueueMessage, toIsoNow, ulid } from "@uplink/contracts";
import {
	getIngestError,
	getRun,
	insertRunIfMissing,
	recordIngestError,
} from "../../lib/db";
import { retryFailedOperation } from "../../lib/processing";
import { createTestIngestEnvelope } from "./fixtures";
import type { Env } from "../../types";

describe("retry recovery", () => {
	it("retries from queue-message payload", async () => {
		const { env } = await import("cloudflare:test");
		const testEnv = env as Env;

		const envelope = createTestIngestEnvelope({
			ingestId: `retry-queue-${ulid()}`,
			recordCount: 1,
		});
		const message = createIngestQueueMessage(envelope, {
			requestId: `req-${ulid()}`,
		});

		const errorId = await recordIngestError(testEnv.CONTROL_DB, {
			runId: envelope.ingestId,
			sourceId: envelope.sourceId,
			phase: "processing",
			errorCode: "TEST_RETRY",
			errorMessage: "Synthetic retry failure",
			payload: JSON.stringify(message),
			status: "pending",
		});

		const result = await retryFailedOperation(testEnv, errorId, {
			triggeredBy: "integration-test",
		});

		expect(result.success).toBe(true);
		expect(result.newStatus).toBe("resolved");

		const run = await getRun(testEnv.CONTROL_DB, envelope.ingestId);
		expect(run?.status).toBe("normalized");

		const updatedError = await getIngestError(testEnv.CONTROL_DB, errorId);
		expect(updatedError?.status).toBe("resolved");
	});

	it("retries from raw-envelope payload", async () => {
		const { env } = await import("cloudflare:test");
		const testEnv = env as Env;

		const envelope = createTestIngestEnvelope({
			ingestId: `retry-envelope-${ulid()}`,
			recordCount: 2,
		});

		const errorId = await recordIngestError(testEnv.CONTROL_DB, {
			runId: envelope.ingestId,
			sourceId: envelope.sourceId,
			phase: "processing",
			errorCode: "TEST_RETRY",
			errorMessage: "Synthetic retry failure",
			payload: JSON.stringify(envelope),
			status: "pending",
		});

		const result = await retryFailedOperation(testEnv, errorId, {
			triggeredBy: "integration-test",
		});

		expect(result.success).toBe(true);
		expect(result.newStatus).toBe("resolved");

		const run = await getRun(testEnv.CONTROL_DB, envelope.ingestId);
		expect(run?.status).toBe("normalized");
		expect(run?.record_count).toBe(2);

		const updatedError = await getIngestError(testEnv.CONTROL_DB, errorId);
		expect(updatedError?.status).toBe("resolved");
	});

	it("falls back to stored run envelope when payload is invalid", async () => {
		const { env } = await import("cloudflare:test");
		const testEnv = env as Env;

		const envelope = createTestIngestEnvelope({
			ingestId: `retry-fallback-${ulid()}`,
			recordCount: 1,
		});

		await insertRunIfMissing(testEnv.CONTROL_DB, {
			runId: envelope.ingestId,
			sourceId: envelope.sourceId,
			sourceName: envelope.sourceName,
			sourceType: envelope.sourceType,
			status: "received",
			collectedAt: envelope.collectedAt,
			receivedAt: toIsoNow(),
			recordCount: envelope.records.length,
			envelope,
			triggeredBy: "queue",
		});

		const errorId = await recordIngestError(testEnv.CONTROL_DB, {
			runId: envelope.ingestId,
			sourceId: envelope.sourceId,
			phase: "processing",
			errorCode: "TEST_RETRY",
			errorMessage: "Synthetic retry failure",
			payload: "not-json",
			status: "pending",
		});

		const result = await retryFailedOperation(testEnv, errorId, {
			triggeredBy: "integration-test",
		});

		expect(result.success).toBe(true);
		expect(result.newStatus).toBe("resolved");

		const run = await getRun(testEnv.CONTROL_DB, envelope.ingestId);
		expect(run?.status).toBe("normalized");

		const updatedError = await getIngestError(testEnv.CONTROL_DB, errorId);
		expect(updatedError?.status).toBe("resolved");
	});
});
