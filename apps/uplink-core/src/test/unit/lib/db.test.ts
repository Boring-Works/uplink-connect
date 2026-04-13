import { describe, expect, it, vi } from "vitest";
import {
	upsertSourceConfig,
	getSourceConfigWithPolicy,
	listRuns,
	getRun,
	setRunStatus,
	insertRunIfMissing,
	checkIdempotencyKey,
	recordIdempotencyKey,
	getArtifact,
	listIngestErrors,
	updateErrorRetryState,
	recordIngestError,
	getIngestError,
	cleanupOldIdempotencyKeys,
	upsertRuntimeSnapshot,
	upsertNormalizedEntities,
} from "../../../lib/db";

describe("checkIdempotencyKey", () => {
	it("returns exists=true when key found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({ result: "success" }),
				}),
			}),
		} as unknown as D1Database;

		const result = await checkIdempotencyKey(mockDb, "key-123");
		expect(result.exists).toBe(true);
		expect(result.result).toBe("success");
	});

	it("returns exists=false when key not found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue(null),
				}),
			}),
		} as unknown as D1Database;

		const result = await checkIdempotencyKey(mockDb, "key-123");
		expect(result.exists).toBe(false);
	});
});

describe("recordIdempotencyKey", () => {
	it("inserts key successfully", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					run: mockRun,
				}),
			}),
		} as unknown as D1Database;

		await recordIdempotencyKey(mockDb, "key-123", "error-456", "success");
		expect(mockRun).toHaveBeenCalledTimes(1);
	});
});

describe("getArtifact", () => {
	it("returns artifact when found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({
						artifact_id: "art-1",
						run_id: "run-1",
						source_id: "src-1",
					}),
				}),
			}),
		} as unknown as D1Database;

		const result = await getArtifact(mockDb, "art-1");
		expect(result).not.toBeNull();
		expect(result?.artifact_id).toBe("art-1");
	});

	it("returns null when not found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue(null),
				}),
			}),
		} as unknown as D1Database;

		const result = await getArtifact(mockDb, "art-1");
		expect(result).toBeNull();
	});
});

describe("listRuns", () => {
	it("returns paginated runs", async () => {
		const mockFirst = vi.fn().mockResolvedValue({ total: 2 });
		const mockAll = vi.fn().mockResolvedValue({
			results: [{ run_id: "run-1" }, { run_id: "run-2" }],
		});
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				first: mockFirst,
				bind: vi.fn().mockReturnValue({
					first: mockFirst,
					all: mockAll,
				}),
			}),
		} as unknown as D1Database;

		const result = await listRuns(mockDb, { limit: 1000 });
		expect(result.items).toHaveLength(2);
		expect(result.total).toBe(2);
		expect(result.hasMore).toBe(false);
	});

	it("caps limit at 500", async () => {
		const mockAll = vi.fn().mockResolvedValue({ results: [] });
		const mockFirst = vi.fn().mockResolvedValue({ total: 0 });
		const mockBind = vi.fn().mockReturnValue({ all: mockAll, first: mockFirst });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				first: mockFirst,
				bind: mockBind,
			}),
		} as unknown as D1Database;

		await listRuns(mockDb, { limit: 1000 });
		// Second bind call is for data query (first is count)
		expect(mockBind.mock.calls[0][0]).toBe(500);
	});

	it("ensures minimum limit of 1", async () => {
		const mockAll = vi.fn().mockResolvedValue({ results: [] });
		const mockFirst = vi.fn().mockResolvedValue({ total: 0 });
		const mockBind = vi.fn().mockReturnValue({ all: mockAll, first: mockFirst });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				first: mockFirst,
				bind: mockBind,
			}),
		} as unknown as D1Database;

		await listRuns(mockDb, { limit: 0 });
		expect(mockBind.mock.calls[0][0]).toBe(1);
	});
});

describe("getRun", () => {
	it("returns run when found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({ run_id: "run-1", status: "normalized" }),
				}),
			}),
		} as unknown as D1Database;

		const result = await getRun(mockDb, "run-1");
		expect(result?.run_id).toBe("run-1");
	});

	it("returns null when not found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue(null),
				}),
			}),
		} as unknown as D1Database;

		const result = await getRun(mockDb, "run-1");
		expect(result).toBeNull();
	});
});

describe("setRunStatus", () => {
	it("updates run status", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		await setRunStatus(mockDb, "run-1", "normalized", { normalizedCount: 10 });
		expect(mockRun).toHaveBeenCalledTimes(1);
	});

	it("updates error message when provided", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		await setRunStatus(mockDb, "run-1", "failed", { errorMessage: "Something failed" });
		expect(mockRun).toHaveBeenCalledTimes(2);
	});
});

describe("listIngestErrors", () => {
	it("returns errors with filters", async () => {
		const mockDb = {
			prepare: vi.fn().mockImplementation((sql: string) => ({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({ total: 1 }),
					all: vi.fn().mockResolvedValue({
						results: [{
							error_id: "err-1",
							run_id: "run-1",
							source_id: "src-1",
							phase: "processing",
							error_code: "E1",
							error_message: "msg",
							status: "pending",
							retry_count: 0,
							last_retry_at: null,
							created_at: 1704067200,
							payload_preview: null,
						}],
					}),
				}),
			})),
		} as unknown as D1Database;

		const result = await listIngestErrors(mockDb, {
			status: "pending",
			limit: 10,
			offset: 0,
		});

		expect(result.errors).toHaveLength(1);
		expect(result.total).toBe(1);
	});
});

describe("updateErrorRetryState", () => {
	it("updates error retry state", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		await updateErrorRetryState(mockDb, "err-1", {
			status: "resolved",
			retryCount: 1,
			lastRetryAt: 12345,
			retryAttempts: [],
		});

		expect(mockRun).toHaveBeenCalledTimes(1);
	});
});

describe("upsertSourceConfig", () => {
	it("inserts new source config", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		await upsertSourceConfig(mockDb, {
			sourceId: "src-1",
			name: "Test Source",
			type: "api",
			adapterType: "api",
			endpointUrl: "https://api.example.com",
			policy: {
				leaseTtlSeconds: 60,
				minIntervalSeconds: 60,
				maxRecordsPerRun: 100,
				retryLimit: 3,
				timeoutSeconds: 60,
			},
		});

		expect(mockRun).toHaveBeenCalled();
	});
});

describe("getSourceConfigWithPolicy", () => {
	it("returns config and policy when found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({
						source_id: "src-1",
						name: "Test",
						type: "api",
						adapter_type: "api",
						status: "active",
						min_interval_seconds: 60,
						lease_ttl_seconds: 300,
						max_records_per_run: 1000,
						retry_limit: 3,
						timeout_seconds: 60,
					}),
				}),
			}),
		} as unknown as D1Database;

		const result = await getSourceConfigWithPolicy(mockDb, "src-1");
		expect(result).not.toBeNull();
		expect(result?.config.sourceId).toBe("src-1");
		expect(result?.policy.leaseTtlSeconds).toBe(300);
	});

	it("returns null when not found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue(null),
				}),
			}),
		} as unknown as D1Database;

		const result = await getSourceConfigWithPolicy(mockDb, "src-1");
		expect(result).toBeNull();
	});
});

describe("insertRunIfMissing", () => {
	it("inserts run when not exists", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		await insertRunIfMissing(mockDb, {
			runId: "run-1",
			sourceId: "src-1",
			sourceName: "Test",
			sourceType: "api",
			status: "received",
			collectedAt: "2024-01-01T00:00:00Z",
			receivedAt: "2024-01-01T00:00:00Z",
			recordCount: 1,
			envelope: {
				ingestId: "run-1",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00Z",
				records: [{ id: "r1", contentHash: "hash12345678901234567890", rawPayload: {} }],
				schemaVersion: "1.0",
			},
		});

		expect(mockRun).toHaveBeenCalled();
	});
});

describe("recordIngestError", () => {
	it("records error with classification", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		const errorId = await recordIngestError(mockDb, {
			runId: "run-1",
			sourceId: "src-1",
			phase: "processing",
			errorCode: "E500",
			errorMessage: "network timeout",
		});

		expect(errorId).toBeDefined();
		expect(mockRun).toHaveBeenCalledTimes(1);
	});

	it("uses provided error category over classification", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		const errorId = await recordIngestError(mockDb, {
			phase: "validation",
			errorCode: "E400",
			errorMessage: "bad request",
			errorCategory: "client_error",
			retryAttempts: [{ attemptedAt: 123, errorMessage: "first try" }],
		});

		expect(errorId).toBeDefined();
		expect(mockRun).toHaveBeenCalledTimes(1);
	});
});

describe("getIngestError", () => {
	it("returns error when found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({
						error_id: "err-1",
						status: "pending",
					}),
				}),
			}),
		} as unknown as D1Database;

		const result = await getIngestError(mockDb, "err-1");
		expect(result?.error_id).toBe("err-1");
	});

	it("returns null when not found", async () => {
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue(null),
				}),
			}),
		} as unknown as D1Database;

		const result = await getIngestError(mockDb, "err-1");
		expect(result).toBeNull();
	});
});

describe("cleanupOldIdempotencyKeys", () => {
	it("deletes old keys and returns count", async () => {
		const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 5 } });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		const count = await cleanupOldIdempotencyKeys(mockDb, 24);
		expect(count).toBe(5);
		expect(mockRun).toHaveBeenCalledTimes(1);
	});

	it("returns zero when no changes", async () => {
		const mockRun = vi.fn().mockResolvedValue({ meta: {} });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		const count = await cleanupOldIdempotencyKeys(mockDb, 1);
		expect(count).toBe(0);
	});
});

describe("upsertRuntimeSnapshot", () => {
	it("upserts snapshot successfully", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		await upsertRuntimeSnapshot(mockDb, {
			sourceId: "src-1",
			leaseOwner: "owner-1",
			leaseToken: "token-1",
			leaseExpiresAt: 1234567890,
			cursor: "cursor-1",
			nextAllowedAt: 1234567900,
			consecutiveFailures: 0,
			lastRunId: "run-1",
			lastSuccessAt: 1234567890,
			lastErrorAt: null,
			lastErrorMessage: null,
		});

		expect(mockRun).toHaveBeenCalledTimes(1);
	});
});

describe("upsertNormalizedEntities", () => {
	it("upserts multiple entities", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const mockDb = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({ run: mockRun }),
			}),
		} as unknown as D1Database;

		await upsertNormalizedEntities(mockDb, "run-1", [
			{
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: "{}",
				observedAt: "2024-01-01T00:00:00Z",
			},
			{
				entityId: "ent-2",
				sourceId: "src-1",
				externalId: null,
				contentHash: "hash-2",
				canonicalJson: "{}",
				observedAt: "2024-01-01T00:00:00Z",
			},
		]);

		expect(mockRun).toHaveBeenCalledTimes(4);
	});
});

describe("listIngestErrors filters", () => {
	it("applies sourceId filter", async () => {
		const mockDb = {
			prepare: vi.fn().mockImplementation((sql: string) => ({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({ total: 0 }),
					all: vi.fn().mockResolvedValue({ results: [] }),
				}),
			})),
		} as unknown as D1Database;

		await listIngestErrors(mockDb, { sourceId: "src-1" });
		const calls = mockDb.prepare.mock.calls as string[][];
		expect(calls.some((c) => c[0].includes("source_id = ?"))).toBe(true);
	});

	it("applies date range filters", async () => {
		const mockDb = {
			prepare: vi.fn().mockImplementation((sql: string) => ({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({ total: 0 }),
					all: vi.fn().mockResolvedValue({ results: [] }),
				}),
			})),
		} as unknown as D1Database;

		await listIngestErrors(mockDb, {
			fromDate: "2024-01-01",
			toDate: "2024-01-02",
		});
		const calls = mockDb.prepare.mock.calls as string[][];
		expect(calls.some((c) => c[0].includes("created_at >= ?"))).toBe(true);
		expect(calls.some((c) => c[0].includes("created_at <= ?"))).toBe(true);
	});

	it("returns empty list when no results", async () => {
		const mockDb = {
			prepare: vi.fn().mockImplementation((sql: string) => ({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({ total: 0 }),
					all: vi.fn().mockResolvedValue({ results: [] }),
				}),
			})),
		} as unknown as D1Database;

		const result = await listIngestErrors(mockDb, {});
		expect(result.errors).toHaveLength(0);
		expect(result.total).toBe(0);
	});
});
