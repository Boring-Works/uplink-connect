import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	processQueueBatch,
	handleIngestMessage,
	retryFailedOperation,
} from "../../../lib/processing";
import type { Env } from "../../../types";
import type { IngestEnvelope, IngestQueueMessage } from "@uplink/contracts";
import * as db from "../../../lib/db";

vi.mock("../../../lib/db", () => ({
	insertRunIfMissing: vi.fn().mockResolvedValue(undefined),
	recordIngestError: vi.fn().mockResolvedValue("err-1"),
	setRunStatus: vi.fn().mockResolvedValue(undefined),
	updateErrorRetryState: vi.fn().mockResolvedValue(undefined),
	getIngestError: vi.fn().mockResolvedValue(null),
	checkIdempotencyKey: vi.fn().mockResolvedValue({ exists: false }),
	recordIdempotencyKey: vi.fn().mockResolvedValue(undefined),
	upsertNormalizedEntities: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/metrics", () => ({
	writeIngestMetrics: vi.fn().mockReturnValue(undefined),
	writeEntityMetrics: vi.fn().mockReturnValue(undefined),
	writeQueueMetrics: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../lib/vectorize", () => ({
	upsertEntityVectors: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@uplink/normalizers", () => ({
	normalizeEnvelope: vi.fn().mockReturnValue([]),
}));

function createMockEnv(): Env {
	const mockRun = vi.fn().mockResolvedValue({ success: true });
	const mockFirst = vi.fn().mockResolvedValue(null);
	const mockAll = vi.fn().mockResolvedValue({ results: [] });
	const mockBind = vi.fn().mockReturnValue({ run: mockRun, first: mockFirst, all: mockAll });
	const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });

	return {
		CONTROL_DB: {
			prepare: mockPrepare,
		} as unknown as D1Database,
		RAW_BUCKET: {
			put: vi.fn().mockResolvedValue(undefined),
		} as unknown as R2Bucket,
		DLQ: {
			send: vi.fn().mockResolvedValue(undefined),
		} as unknown as Queue,
		OPS_METRICS: {
			writeDataPoint: vi.fn().mockReturnValue(undefined),
		} as unknown as AnalyticsEngineDataset,
		AI: {} as Ai,
		ENTITY_INDEX: {} as VectorizeIndex,
	} as unknown as Env;
}

function createMessage(body: unknown, attempts = 1): Message<unknown> {
	return {
		body,
		attempts,
		ack: vi.fn(),
		retry: vi.fn(),
	} as unknown as Message<unknown>;
}

describe("processing", () => {
	let env: Env;

	beforeEach(() => {
		env = createMockEnv();
		vi.clearAllMocks();
		// Restore default mock behaviors that tests may override
		vi.mocked(db.insertRunIfMissing).mockResolvedValue(undefined);
		vi.mocked(db.recordIngestError).mockResolvedValue("err-1");
		vi.mocked(db.setRunStatus).mockResolvedValue(undefined);
		vi.mocked(db.updateErrorRetryState).mockResolvedValue(undefined);
		vi.mocked(db.getIngestError).mockResolvedValue(null);
		vi.mocked(db.checkIdempotencyKey).mockResolvedValue({ exists: false });
		vi.mocked(db.recordIdempotencyKey).mockResolvedValue(undefined);
		vi.mocked(db.upsertNormalizedEntities).mockResolvedValue(undefined);
	});

	describe("processQueueBatch", () => {
		it("acks valid messages after processing", async () => {
			const envelope: IngestEnvelope = {
				ingestId: "run-1",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00Z",
				records: [{ id: "r1", data: {} }],
				metadata: {},
			};
			const msg = createMessage({
				envelope,
				receivedAt: "2024-01-01T00:01:00Z",
				requestId: "req-1",
			});

			await processQueueBatch({ messages: [msg] } as MessageBatch<unknown>, env);

			expect(msg.ack).toHaveBeenCalled();
			expect(msg.retry).not.toHaveBeenCalled();
		});

		it("acks invalid messages and records validation error", async () => {
			const msg = createMessage({ bad: true });
			await processQueueBatch({ messages: [msg] } as MessageBatch<unknown>, env);
			expect(msg.ack).toHaveBeenCalled();
			expect(db.recordIngestError).toHaveBeenCalledWith(
				env.CONTROL_DB,
				expect.objectContaining({ phase: "validation", errorCode: "INVALID_MESSAGE" }),
			);
		});

		it("acks messages after processing even on errors", async () => {
			const envelope: IngestEnvelope = {
				ingestId: "run-1",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00Z",
				records: [{ id: "r1", data: {} }],
				metadata: {},
			};
			const msg = createMessage({ envelope, receivedAt: "2024-01-01T00:01:00Z" });

			vi.mocked(db.insertRunIfMissing).mockRejectedValue(new Error("DB error"));

			await processQueueBatch({ messages: [msg] } as MessageBatch<unknown>, env);

			expect(msg.ack).toHaveBeenCalled();
		});
	});

	describe("handleIngestMessage", () => {
		const envelope: IngestEnvelope = {
			ingestId: "run-1",
			sourceId: "src-1",
			sourceName: "Test",
			sourceType: "api",
			collectedAt: "2024-01-01T00:00:00Z",
			records: [{ id: "r1", data: { name: "Alice" } }],
			metadata: {},
		};

		const message: IngestQueueMessage = {
			envelope,
			receivedAt: "2024-01-01T00:01:00Z",
			requestId: "req-1",
		};

		it("throws when envelope is missing", async () => {
			await expect(handleIngestMessage(env, { receivedAt: "", requestId: "" } as IngestQueueMessage)).rejects.toThrow("envelope is required");
		});

		it("throws when records is not an array", async () => {
			await expect(handleIngestMessage(env, { envelope: { records: "bad" } as unknown as IngestEnvelope, receivedAt: "", requestId: "" })).rejects.toThrow("records must be an array");
		});

		it("processes a valid message end-to-end", async () => {
			await handleIngestMessage(env, message);
			expect(db.insertRunIfMissing).toHaveBeenCalled();
			expect(env.RAW_BUCKET.put).toHaveBeenCalled();
			expect(db.setRunStatus).toHaveBeenCalledWith(env.CONTROL_DB, "run-1", "normalized", expect.any(Object));
		});

		it("uses replayOfRunId when present in metadata", async () => {
			const replayMessage: IngestQueueMessage = {
				envelope: { ...envelope, metadata: { replayOf: "run-0" } },
				receivedAt: "2024-01-01T00:01:00Z",
				requestId: "req-1",
			};
			await handleIngestMessage(env, replayMessage);
			expect(db.insertRunIfMissing).toHaveBeenCalledWith(
				env.CONTROL_DB,
				expect.objectContaining({ replayOfRunId: "run-0" }),
			);
		});
	});

	describe("retryFailedOperation", () => {
		it("returns not found when error does not exist", async () => {
			const result = await retryFailedOperation(env, "err-missing");
			expect(result.success).toBe(false);
			expect(result.message).toContain("not found");
		});

		it("returns already resolved when status is resolved", async () => {
			vi.mocked(db.getIngestError).mockResolvedValue({ status: "resolved" } as unknown as Record<string, unknown>);
			const result = await retryFailedOperation(env, "err-1");
			expect(result.success).toBe(true);
			expect(result.newStatus).toBe("resolved");
		});

		it("blocks retry when max retries exceeded without force", async () => {
			vi.mocked(db.getIngestError).mockResolvedValue({ status: "retrying", retry_count: 3, max_retries: 3 } as unknown as Record<string, unknown>);
			const result = await retryFailedOperation(env, "err-1");
			expect(result.success).toBe(false);
			expect(result.message).toContain("Max retries");
		});

		it("returns idempotency hit when already retried successfully", async () => {
			vi.mocked(db.getIngestError).mockResolvedValue({ status: "retrying", retry_count: 1, max_retries: 3 } as unknown as Record<string, unknown>);
			vi.mocked(db.checkIdempotencyKey).mockResolvedValue({ exists: true, result: "success" });
			const result = await retryFailedOperation(env, "err-1");
			expect(result.success).toBe(true);
			expect(result.message).toContain("already completed");
		});

		it("rejects validation phase retries", async () => {
			vi.mocked(db.getIngestError).mockResolvedValue({
				status: "dead_letter",
				retry_count: 0,
				max_retries: 3,
				phase: "validation",
				payload: "{}",
			} as unknown as Record<string, unknown>);
			const result = await retryFailedOperation(env, "err-1", { force: true });
			expect(result.success).toBe(false);
			expect(result.message).toContain("Validation errors cannot be retried");
		});

		it("allows retry with force flag exceeding max retries", async () => {
			vi.mocked(db.getIngestError).mockResolvedValue({
				status: "pending",
				retry_count: 3,
				max_retries: 3,
				phase: "processing",
				payload: JSON.stringify({
					envelope: {
						schemaVersion: "1.0",
						ingestId: "run-12345678",
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "api",
						collectedAt: "2024-01-01T00:00:00.000Z",
						records: [{ contentHash: "abc12345678901234567", rawPayload: {} }],
					},
					receivedAt: "2024-01-01T00:01:00.000Z",
				}),
			} as unknown as Record<string, unknown>);

			const result = await retryFailedOperation(env, "err-1", { force: true });
			expect(result.success).toBe(true);
			expect(result.newStatus).toBe("resolved");
		});
	});
});
