import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../../types";
import {
	writeMetric,
	writeIngestMetrics,
	writeQueueMetrics,
	writeEntityMetrics,
	writeCoordinatorMetrics,
	getPerSourceMetrics,
	getAllSourceMetrics,
	getQueueMetrics,
	getEntityMetrics,
	getSystemMetrics,
	aggregateMetricsWindow,
	getAggregatedSourceMetrics,
} from "../../../lib/metrics";

describe("metrics", () => {
	let mockEnv: Env;
	let writtenDataPoints: Array<{ blobs: (string | null)[]; doubles: number[]; indexes: string[] }>;

	beforeEach(() => {
		writtenDataPoints = [];
		mockEnv = {
			OPS_METRICS: {
				writeDataPoint: vi.fn((dp) => {
					writtenDataPoints.push(dp as { blobs: (string | null)[]; doubles: number[]; indexes: string[] });
				}),
			},
		} as unknown as Env;
	});

	describe("writeMetric", () => {
		it("writes a basic metric with default value 1", () => {
			writeMetric(mockEnv, {
				sourceId: "src-1",
				sourceType: "api",
				event: "test.event",
			});

			expect(writtenDataPoints).toHaveLength(1);
			expect(writtenDataPoints[0].doubles).toEqual([1]);
			expect(writtenDataPoints[0].blobs).toEqual(["src-1", "api", "test.event", null]);
		});

		it("writes a metric with custom value and metadata", () => {
			writeMetric(mockEnv, {
				sourceId: "src-1",
				sourceType: "api",
				event: "ingest.success",
				value: 42,
				index: "run-123",
				metadata: { foo: "bar", count: 5 },
			});

			expect(writtenDataPoints[0].doubles).toEqual([42]);
			expect(writtenDataPoints[0].blobs[3]).toEqual('{"foo":"bar","count":5}');
			expect(writtenDataPoints[0].indexes).toEqual(["run-123"]);
		});

		it("uses a default index when not provided", () => {
			writeMetric(mockEnv, { sourceId: "src-1", sourceType: "api", event: "test" });
			expect(writtenDataPoints[0].indexes[0]).toBe("default");
		});

		it("throws when OPS_METRICS is missing", () => {
			const envWithoutMetrics = {} as Env;
			expect(() => writeMetric(envWithoutMetrics, { sourceId: "src-1", sourceType: "api", event: "test.event" })).toThrow();
		});
	});

	describe("writeIngestMetrics", () => {
		it("writes success metrics including latency and normalization rate", () => {
			writeIngestMetrics(mockEnv, {
				sourceId: "src-1",
				sourceType: "api",
				runId: "run-123",
				status: "success",
				recordCount: 10,
				normalizedCount: 8,
				errorCount: 1,
				processingTimeMs: 150,
			});

			// Should write 4 data points: ingest.success, latency, normalization_rate, error_rate
			expect(writtenDataPoints).toHaveLength(4);
			const events = writtenDataPoints.map((dp) => dp.blobs[2]);
			expect(events).toContain("ingest.success");
			expect(events).toContain("ingest.latency_ms");
			expect(events).toContain("ingest.normalization_rate");
			expect(events).toContain("ingest.error_rate");
		});

		it("skips normalization rate when recordCount is 0", () => {
			writeIngestMetrics(mockEnv, {
				sourceId: "src-1",
				sourceType: "api",
				runId: "run-123",
				status: "failure",
				recordCount: 0,
				normalizedCount: 0,
				errorCount: 0,
				processingTimeMs: 50,
			});

			const events = writtenDataPoints.map((dp) => dp.blobs[2]);
			expect(events).toContain("ingest.failure");
			expect(events).toContain("ingest.latency_ms");
			expect(events).not.toContain("ingest.normalization_rate");
			expect(events).not.toContain("ingest.error_rate");
		});

		it("skips error rate when errorCount is 0", () => {
			writeIngestMetrics(mockEnv, {
				sourceId: "src-1",
				sourceType: "api",
				runId: "run-123",
				status: "success",
				recordCount: 10,
				normalizedCount: 10,
				errorCount: 0,
				processingTimeMs: 100,
			});

			const events = writtenDataPoints.map((dp) => dp.blobs[2]);
			expect(events).not.toContain("ingest.error_rate");
		});
	});

	describe("writeQueueMetrics", () => {
		it("writes lag, pending, and processing metrics", () => {
			writeQueueMetrics(mockEnv, {
				queueLagSeconds: 12.5,
				pendingCount: 5,
				processingCount: 2,
			});

			expect(writtenDataPoints).toHaveLength(3);
			const events = writtenDataPoints.map((dp) => dp.blobs[2]);
			expect(events).toEqual([
				"queue.lag_seconds",
				"queue.pending_count",
				"queue.processing_count",
			]);
			expect(writtenDataPoints[0].doubles).toEqual([12.5]);
			expect(writtenDataPoints[1].doubles).toEqual([5]);
			expect(writtenDataPoints[2].doubles).toEqual([2]);
		});

		it("throws when OPS_METRICS is missing", () => {
			const envWithoutMetrics = {} as Env;
			expect(() => writeQueueMetrics(envWithoutMetrics, { queueLagSeconds: 0, pendingCount: 0, processingCount: 0 })).toThrow();
		});
	});

	describe("writeEntityMetrics", () => {
		it("writes entity.created for new entities", () => {
			writeEntityMetrics(mockEnv, {
				sourceId: "src-1",
				sourceType: "api",
				entityCount: 1,
				isNew: true,
				isUpdate: false,
			});

			expect(writtenDataPoints[0].blobs[2]).toBe("entity.created");
			expect(writtenDataPoints[0].doubles).toEqual([1]);
		});

		it("writes entity.observed for existing entities with update flag", () => {
			writeEntityMetrics(mockEnv, {
				sourceId: "src-1",
				sourceType: "api",
				entityCount: 1,
				isNew: false,
				isUpdate: true,
			});

			expect(writtenDataPoints[0].blobs[2]).toBe("entity.observed");
			expect(writtenDataPoints[0].doubles).toEqual([1]);
			expect(writtenDataPoints[0].blobs[3]).toBe('{"isUpdate":"true"}');
		});
	});

	describe("writeCoordinatorMetrics", () => {
		it("writes lease_acquired metric", () => {
			writeCoordinatorMetrics(mockEnv, {
				sourceId: "src-1",
				event: "lease_acquired",
			});

			expect(writtenDataPoints[0].blobs).toEqual(["src-1", "coordinator", "coordinator.lease_acquired", null]);
			expect(writtenDataPoints[0].doubles).toEqual([1]);
		});

		it("includes consecutiveFailures when provided", () => {
			writeCoordinatorMetrics(mockEnv, {
				sourceId: "src-1",
				event: "failure",
				consecutiveFailures: 3,
			});

			expect(writtenDataPoints[0].doubles).toEqual([3]);
		});
	});

	describe("getPerSourceMetrics", () => {
		it("returns null when no results", async () => {
			const db = createMockDb([]);
			const result = await getPerSourceMetrics(db, "src-1");
			expect(result).toBeNull();
		});

		it("calculates success and failure rates correctly", async () => {
			const db = createMockDb([
				{
					source_id: "src-1",
					source_type: "api",
					total_runs: 10,
					success_count: 7,
					failure_count: 3,
					normalized_count: 14,
					error_count: 2,
				},
			]);

			const result = await getPerSourceMetrics(db, "src-1");
			expect(result).toMatchObject({
				sourceId: "src-1",
				sourceType: "api",
				totalRuns: 10,
				successCount: 7,
				failureCount: 3,
				normalizedCount: 14,
				errorCount: 2,
				successRate: 0.7,
				failureRate: 0.3,
			});
		});

		it("returns 0 rates when totalRuns is 0", async () => {
			const db = createMockDb([
				{
					source_id: "src-1",
					source_type: "api",
					total_runs: 0,
					success_count: 0,
					failure_count: 0,
					normalized_count: 0,
					error_count: 0,
				},
			]);

			const result = await getPerSourceMetrics(db, "src-1");
			expect(result?.successRate).toBe(0);
			expect(result?.failureRate).toBe(0);
		});
	});

	describe("getAllSourceMetrics", () => {
		it("returns empty array for no data", async () => {
			const db = createMockDbAll({ results: [] });
			const result = await getAllSourceMetrics(db);
			expect(result).toEqual([]);
		});

		it("maps multiple source rows", async () => {
			const db = createMockDbAll({
				results: [
					{
						source_id: "src-1",
						source_type: "api",
						total_runs: 5,
						success_count: 5,
						failure_count: 0,
						normalized_count: 10,
						error_count: 0,
					},
					{
						source_id: "src-2",
						source_type: "webhook",
						total_runs: 8,
						success_count: 6,
						failure_count: 2,
						normalized_count: 12,
						error_count: 1,
					},
				],
			});

			const result = await getAllSourceMetrics(db);
			expect(result).toHaveLength(2);
			expect(result[0].sourceId).toBe("src-1");
			expect(result[1].sourceId).toBe("src-2");
		});
	});

	describe("getQueueMetrics", () => {
		it("calculates queue lag from oldest unprocessed message", async () => {
			const now = Math.floor(Date.now() / 1000);
			const oldTime = new Date((now - 30) * 1000).toISOString();

			const db = createMultiFirstDb({
				pending: { count: 3 },
				processing: { count: 1 },
				failed: { count: 0 },
				oldest: { received_at: oldTime },
			});

			const result = await getQueueMetrics(db);
			expect(result.pendingCount).toBe(3);
			expect(result.processingCount).toBe(1);
			expect(result.failedCount).toBe(0);
			expect(result.queueLagSeconds).toBeGreaterThanOrEqual(30);
		});

		it("returns 0 lag when no unprocessed messages", async () => {
			const db = createMultiFirstDb({
				pending: { count: 0 },
				processing: { count: 0 },
				failed: { count: 0 },
				oldest: null,
			});

			const result = await getQueueMetrics(db);
			expect(result.queueLagSeconds).toBe(0);
			expect(result.oldestUnprocessedAt).toBeUndefined();
		});
	});

	describe("getEntityMetrics", () => {
		it("aggregates entity counts correctly", async () => {
			const db = createEntityDb({
				total: { count: 100 },
				newToday: { count: 5 },
				updatedToday: { count: 12 },
				bySource: { results: [{ source_id: "src-1", count: 60 }, { source_id: "src-2", count: 40 }] },
			});

			const result = await getEntityMetrics(db);
			expect(result.totalEntities).toBe(100);
			expect(result.newToday).toBe(5);
			expect(result.updatedToday).toBe(12);
			expect(result.bySource).toEqual([
				{ sourceId: "src-1", count: 60 },
				{ sourceId: "src-2", count: 40 },
			]);
		});
	});

	describe("getSystemMetrics", () => {
		it("combines all system-level metrics", async () => {
		const db = createSystemDb({
			sources: { total: 5, active: 3 },
			runs: { count: 42 },
			entities: { count: 1000 },
			queue: { queueLagSeconds: 15, pendingCount: 2, processingCount: 1, failedCount: 0, oldestUnprocessedAt: new Date(Date.now() - 15000).toISOString() },
			alerts: { total: 1, critical: 0 },
		});

		const result = await getSystemMetrics(db);
		expect(result.totalSources).toBe(5);
		expect(result.activeSources).toBe(3);
		expect(result.totalRuns24h).toBe(42);
		expect(result.totalEntities).toBe(1000);
		expect(result.queueLagSeconds).toBeGreaterThan(0);
		expect(result.activeAlerts).toBe(1);
		expect(result.criticalAlerts).toBe(0);
		});
	});

	describe("aggregateMetricsWindow", () => {
		it("inserts aggregated window metrics", async () => {
			const runs: Array<Record<string, unknown>> = [];
			const db = createAggregateDb({
				results: [
					{
						source_id: "src-1",
						total_runs: 4,
						success_count: 3,
						failure_count: 1,
						normalized_count: 6,
						error_count: 1,
						avg_processing_sec: 1.234,
					},
				],
			}, runs);

			await aggregateMetricsWindow(db, 1000, 2000);

			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({
				metricId: "src-1:1000",
				sourceId: "src-1",
				windowStart: 1000,
				windowEnd: 2000,
				totalRuns: 4,
				successCount: 3,
				failureCount: 1,
				normalizedCount: 6,
				errorCount: 1,
				avgProcessingMs: 1234,
			});
		});

		it("handles null avg_processing_sec", async () => {
			const runs: Array<Record<string, unknown>> = [];
			const db = createAggregateDb({
				results: [
					{
						source_id: "src-1",
						total_runs: 1,
						success_count: 1,
						failure_count: 0,
						normalized_count: 2,
						error_count: 0,
						avg_processing_sec: null,
					},
				],
			}, runs);

			await aggregateMetricsWindow(db, 1000, 2000);
			expect(runs[0].avgProcessingMs).toBeNull();
		});
	});
});

// Helpers
function createMockDb(rows: Array<Record<string, unknown>>): D1Database {
	return {
		prepare: () => ({
			bind: () => ({
				first: vi.fn().mockResolvedValue(rows[0] ?? null),
			}),
		}),
	} as unknown as D1Database;
}

function createMockDbAll(response: { results: Array<Record<string, unknown>> }): D1Database {
	return {
		prepare: () => ({
			bind: () => ({
				all: vi.fn().mockResolvedValue(response),
			}),
		}),
	} as unknown as D1Database;
}

function createMultiFirstDb(data: {
	pending: { count: number } | null;
	processing: { count: number } | null;
	failed: { count: number } | null;
	oldest: { received_at: string } | null;
}): D1Database {
	let callIndex = 0;
	const responses = [data.pending, data.processing, data.failed, data.oldest];
	const sharedFirst = vi.fn().mockImplementation(() => Promise.resolve(responses[callIndex++]));
	return {
		prepare: () => ({
			first: sharedFirst,
			bind: vi.fn().mockReturnValue({ first: sharedFirst }),
		}),
	} as unknown as D1Database;
}

function createEntityDb(data: {
	total: { count: number };
	newToday: { count: number };
	updatedToday: { count: number };
	bySource: { results: Array<{ source_id: string; count: number }> };
}): D1Database {
	let callIndex = 0;
	const responses = [data.total, data.newToday, data.updatedToday, data.bySource];
	return {
		prepare: vi.fn().mockImplementation(() => {
			const firstFn = vi.fn().mockImplementation(() => Promise.resolve(responses[callIndex++]));
			const allFn = vi.fn().mockImplementation(() => Promise.resolve(responses[callIndex++]));
			const bindResult = { first: firstFn, all: allFn };
			return { ...bindResult, bind: vi.fn().mockReturnValue(bindResult) };
		}),
	} as unknown as D1Database;
}

function createSystemDb(data: {
	sources: { total: number; active: number };
	runs: { count: number };
	entities: { count: number };
	queue: { queueLagSeconds: number; pendingCount: number; processingCount: number; failedCount: number; oldestUnprocessedAt?: string };
	alerts: { total: number; critical: number };
}): D1Database {
	let firstIndex = 0;
	// getSystemMetrics order: sources, runs (bind), entities, getQueueMetrics (pending, processing, failed, oldest), alerts
	const firstResponses = [
		data.sources,
		data.runs,
		data.entities,
		{ count: data.queue.pendingCount },
		{ count: data.queue.processingCount },
		{ count: data.queue.failedCount },
		data.queue.oldestUnprocessedAt ? { received_at: data.queue.oldestUnprocessedAt } : null,
		data.alerts,
	];
	const sharedFirst = vi.fn().mockImplementation(() => Promise.resolve(firstResponses[firstIndex++]));
	const sharedAll = vi.fn().mockImplementation(() => Promise.resolve({ results: [] }));
	return {
		prepare: vi.fn().mockImplementation(() => ({
			first: sharedFirst,
			all: sharedAll,
			bind: vi.fn().mockReturnValue({ first: sharedFirst, all: sharedAll }),
		})),
	} as unknown as D1Database;
}

function createAggregateDb(
	response: { results: Array<Record<string, unknown>> },
	runs: Array<Record<string, unknown>>,
): D1Database {
	return {
		prepare: vi.fn().mockImplementation((sql: string) => ({
			bind: vi.fn().mockImplementation((...args: (string | number | null)[]) => {
				// Only capture INSERT binds (10 args), not SELECT binds (2 args)
				if (args.length >= 10) {
					runs.push({
						metricId: args[0] as string,
						sourceId: args[1] as string,
						windowStart: args[2] as number,
						windowEnd: args[3] as number,
						totalRuns: args[4] as number,
						successCount: args[5] as number,
						failureCount: args[6] as number,
						normalizedCount: args[7] as number,
						errorCount: args[8] as number,
						avgProcessingMs: args[9] as number | null,
					});
				}
				return {
					all: vi.fn().mockResolvedValue(response),
					run: vi.fn().mockResolvedValue({ success: true }),
				};
			}),
		})),
	} as unknown as D1Database;
}

describe("getAggregatedSourceMetrics", () => {
	it("aggregates metrics for all sources in a single query", async () => {
		const db = createMockDbForAggregation([
			{
				source_id: "src-1",
				total_runs: 10,
				success_count: 8,
				failure_count: 2,
				normalized_count: 15,
				error_count: 1,
				avg_processing_ms: 1500,
				metadata_counts: '{"manual":5,"cron":5}',
			},
			{
				source_id: "src-2",
				total_runs: 5,
				success_count: 5,
				failure_count: 0,
				normalized_count: 8,
				error_count: 0,
				avg_processing_ms: null,
				metadata_counts: null,
			},
		]);

		const result = await getAggregatedSourceMetrics(db, 3600);
		expect(result).toHaveLength(2);

		const src1 = result.find((r) => r.sourceId === "src-1");
		expect(src1).toBeDefined();
		expect(src1?.totalRuns).toBe(10);
		expect(src1?.successCount).toBe(8);
		expect(src1?.failureCount).toBe(2);
		expect(src1?.normalizedCount).toBe(15);
		expect(src1?.errorCount).toBe(1);
		expect(src1?.avgProcessingMs).toBe(1500);
		expect(src1?.metadataCounts).toEqual({ manual: 5, cron: 5 });

		const src2 = result.find((r) => r.sourceId === "src-2");
		expect(src2?.totalRuns).toBe(5);
		expect(src2?.avgProcessingMs).toBeNull();
		expect(src2?.metadataCounts).toEqual({});
	});

	it("throws when result count exceeds maxResults", async () => {
		const db = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					first: vi.fn().mockResolvedValue({ count: 50001 }),
				}),
			}),
		} as unknown as D1Database;

		await expect(getAggregatedSourceMetrics(db, 3600, 50000)).rejects.toThrow(
			"Result count 50001 exceeds maximum 50000",
		);
	});

	it("returns empty array when no results", async () => {
		const db = createMockDbForAggregation([]);
		const result = await getAggregatedSourceMetrics(db, 3600);
		expect(result).toEqual([]);
	});
});

function createMockDbForAggregation(
	rows: Array<{
		source_id: string;
		total_runs: number;
		success_count: number;
		failure_count: number;
		normalized_count: number;
		error_count: number;
		avg_processing_ms: number | null;
		metadata_counts: string | null;
	}>,
): D1Database {
	return {
		prepare: vi.fn().mockReturnValue({
			bind: vi.fn().mockImplementation((...args: unknown[]) => {
				// First call is count check
				if (args.length === 1) {
					return {
						first: vi.fn().mockResolvedValue({ count: rows.length * 2 }),
					};
				}
				// Second call is aggregation query
				return {
					all: vi.fn().mockResolvedValue({ results: rows }),
				};
			}),
		}),
	} as unknown as D1Database;
}
