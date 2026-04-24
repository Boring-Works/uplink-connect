import { safeJsonParse } from "@uplink/contracts";
import type { Env } from "../types";

const METRICS_CACHE_TTL_SECONDS = 30;

interface CachedMetrics<T> {
	data: T;
	cachedAt: number;
}

/** Cache dashboard metrics to reduce D1 load. Uses Cache API with explicit timestamp-based expiry. */
async function getCachedMetrics<T>(cacheKey: string, fetcher: () => Promise<T>): Promise<T> {
	if (typeof caches === "undefined") {
		return fetcher();
	}
	const cache = (caches as unknown as { default: Cache }).default;
	const key = new Request(`https://internal/cache/metrics/${cacheKey}`);
	const cached = await cache.match(key);
	if (cached) {
		try {
			const wrapper = await cached.json() as CachedMetrics<T>;
			const ageMs = Date.now() - wrapper.cachedAt;
			if (ageMs < METRICS_CACHE_TTL_SECONDS * 1000) {
				return wrapper.data;
			}
			// expired: fall through to refresh
		} catch {
			// fall through
		}
	}
	const result = await fetcher();
	try {
		await cache.put(
			key,
			new Response(
				JSON.stringify({ data: result, cachedAt: Date.now() } as CachedMetrics<T>),
				{
					headers: { "Cache-Control": `max-age=${METRICS_CACHE_TTL_SECONDS}` },
				},
			),
		);
	} catch {
		// cache put failures are non-critical
	}
	return result;
}

export interface SourceMetrics {
	sourceId: string;
	sourceType: string;
	totalRuns: number;
	successCount: number;
	failureCount: number;
	normalizedCount: number;
	errorCount: number;
	successRate: number;
	failureRate: number;
	avgProcessingMs?: number;
	p50LatencyMs?: number;
	p95LatencyMs?: number;
	p99LatencyMs?: number;
}

export interface QueueMetrics {
	oldestUnprocessedAt?: string;
	queueLagSeconds: number;
	pendingCount: number;
	processingCount: number;
	failedCount: number;
}

export interface EntityMetrics {
	totalEntities: number;
	newToday: number;
	updatedToday: number;
	bySource: Array<{
		sourceId: string;
		count: number;
	}>;
}

export interface SystemMetrics {
	totalSources: number;
	activeSources: number;
	totalRuns24h: number;
	totalEntities: number;
	queueLagSeconds: number;
	activeAlerts: number;
	criticalAlerts: number;
}

export function writeMetric(
	env: Env,
	params: {
		sourceId: string;
		sourceType: string;
		event: string;
		value?: number;
		index?: string;
		metadata?: Record<string, string | number>;
	},
): void {
	try {
		const doubles: number[] = [params.value ?? 1];
		const blobs: (string | null)[] = [
			params.sourceId,
			params.sourceType,
			params.event,
			params.metadata ? JSON.stringify(params.metadata) : null,
		];

		env.OPS_METRICS?.writeDataPoint({
			blobs,
			doubles,
			indexes: [params.index ?? "default"],
		});
	} catch {
		// Silently drop metrics — don't break business logic
	}
}

export function writeIngestMetrics(
	env: Env,
	params: {
		sourceId: string;
		sourceType: string;
		runId: string;
		status: "success" | "failure";
		recordCount: number;
		normalizedCount: number;
		errorCount: number;
		processingTimeMs: number;
	},
): void {
	// Primary ingest event
	writeMetric(env, {
		sourceId: params.sourceId,
		sourceType: params.sourceType,
		event: `ingest.${params.status}`,
		value: params.recordCount,
		index: params.runId,
		metadata: {
			normalizedCount: params.normalizedCount,
			errorCount: params.errorCount,
			processingTimeMs: params.processingTimeMs,
		},
	});

	// Processing latency
	writeMetric(env, {
		sourceId: params.sourceId,
		sourceType: params.sourceType,
		event: "ingest.latency_ms",
		value: params.processingTimeMs,
		index: params.runId,
	});

	// Normalization rate
	if (params.recordCount > 0) {
		writeMetric(env, {
			sourceId: params.sourceId,
			sourceType: params.sourceType,
			event: "ingest.normalization_rate",
			value: params.normalizedCount / params.recordCount,
			index: params.runId,
		});
	}

	// Error rate
	if (params.errorCount > 0) {
		writeMetric(env, {
			sourceId: params.sourceId,
			sourceType: params.sourceType,
			event: "ingest.error_rate",
			value: params.errorCount / params.recordCount,
			index: params.runId,
		});
	}
}

export function writeQueueMetrics(
	env: Env,
	params: {
		queueLagSeconds: number;
		pendingCount: number;
		processingCount: number;
	},
): void {
	writeMetric(env, {
		sourceId: "system",
		sourceType: "queue",
		event: "queue.lag_seconds",
		value: params.queueLagSeconds,
		index: `queue:${Date.now()}`,
	});

	writeMetric(env, {
		sourceId: "system",
		sourceType: "queue",
		event: "queue.pending_count",
		value: params.pendingCount,
		index: `queue:${Date.now()}`,
	});

	writeMetric(env, {
		sourceId: "system",
		sourceType: "queue",
		event: "queue.processing_count",
		value: params.processingCount,
		index: `queue:${Date.now()}`,
	});
}

export function writeEntityMetrics(
	env: Env,
	params: {
		sourceId: string;
		sourceType: string;
		entityCount: number;
		isNew: boolean;
		isUpdate: boolean;
	},
): void {
	writeMetric(env, {
		sourceId: params.sourceId,
		sourceType: params.sourceType,
		event: params.isNew ? "entity.created" : "entity.observed",
		value: 1,
		metadata: {
			isUpdate: params.isUpdate ? "true" : "false",
		},
	});
}

export function writeCoordinatorMetrics(
	env: Env,
	params: {
		sourceId: string;
		event: "lease_acquired" | "lease_released" | "lease_expired" | "cursor_advanced" | "success" | "failure";
		consecutiveFailures?: number;
	},
): void {
	writeMetric(env, {
		sourceId: params.sourceId,
		sourceType: "coordinator",
		event: `coordinator.${params.event}`,
		value: params.consecutiveFailures ?? 1,
	});
}

export async function getPerSourceMetrics(
	db: D1Database,
	sourceId: string,
	windowSeconds: number = 3600,
): Promise<SourceMetrics | null> {
	const since = Math.floor(Date.now() / 1000) - windowSeconds;

	const result = await db
		.prepare(
			`SELECT
				s.source_id,
				s.type as source_type,
				COUNT(*) as total_runs,
				SUM(CASE WHEN r.status = 'normalized' THEN 1 ELSE 0 END) as success_count,
				SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) as failure_count,
				SUM(r.normalized_count) as normalized_count,
				SUM(r.error_count) as error_count
			FROM ingest_runs r
			JOIN source_configs s ON s.source_id = r.source_id
			WHERE r.source_id = ? AND r.created_at >= ?`,
		)
		.bind(sourceId, since)
		.first<{
			source_id: string;
			source_type: string;
			total_runs: number;
			success_count: number;
			failure_count: number;
			normalized_count: number;
			error_count: number;
		}>();

	if (!result) {
		return null;
	}

	const totalRuns = result.total_runs;
	const successCount = result.success_count;
	const failureCount = result.failure_count;

	return {
		sourceId: result.source_id,
		sourceType: result.source_type,
		totalRuns,
		successCount,
		failureCount,
		normalizedCount: result.normalized_count,
		errorCount: result.error_count,
		successRate: totalRuns > 0 ? successCount / totalRuns : 0,
		failureRate: totalRuns > 0 ? failureCount / totalRuns : 0,
	};
}

export async function getAllSourceMetrics(
	db: D1Database,
	windowSeconds: number = 3600,
): Promise<SourceMetrics[]> {
	const since = Math.floor(Date.now() / 1000) - windowSeconds;

	const result = await db
		.prepare(
			`SELECT
				s.source_id,
				s.type as source_type,
				COUNT(*) as total_runs,
				SUM(CASE WHEN r.status = 'normalized' THEN 1 ELSE 0 END) as success_count,
				SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) as failure_count,
				SUM(r.normalized_count) as normalized_count,
				SUM(r.error_count) as error_count
			FROM ingest_runs r
			JOIN source_configs s ON s.source_id = r.source_id
			WHERE r.created_at >= ?
			GROUP BY s.source_id`,
		)
		.bind(since)
		.all<{
			source_id: string;
			source_type: string;
			total_runs: number;
			success_count: number;
			failure_count: number;
			normalized_count: number;
			error_count: number;
		}>();

	return (result.results ?? []).map((row) => {
		const totalRuns = row.total_runs;
		const successCount = row.success_count;
		const failureCount = row.failure_count;

		return {
			sourceId: row.source_id,
			sourceType: row.source_type,
			totalRuns,
			successCount,
			failureCount,
			normalizedCount: row.normalized_count,
			errorCount: row.error_count,
			successRate: totalRuns > 0 ? successCount / totalRuns : 0,
			failureRate: totalRuns > 0 ? failureCount / totalRuns : 0,
		};
	});
}

export async function getQueueMetrics(db: D1Database): Promise<QueueMetrics> {
	return getCachedMetrics("queue", async () => {
		const now = Math.floor(Date.now() / 1000);
	const since = now - 86400; // Only look at last 24h to keep queries fast

	const pendingResult = await db
		.prepare(
			`SELECT COUNT(*) as count FROM ingest_runs
			WHERE status IN ('received', 'enqueued')
			AND created_at >= ?`,
		)
		.bind(since)
		.first<{ count: number }>();

	const processingResult = await db
		.prepare(
			`SELECT COUNT(*) as count FROM ingest_runs
			WHERE status IN ('collecting', 'persisted')
			AND created_at >= ?`,
		)
		.bind(since)
		.first<{ count: number }>();

	const failedResult = await db
		.prepare(
			`SELECT COUNT(*) as count FROM ingest_runs
			WHERE status = 'failed'
			AND created_at >= ?`,
		)
		.bind(since)
		.first<{ count: number }>();

	const oldestResult = await db
		.prepare(
			`SELECT received_at FROM ingest_runs
			WHERE status IN ('received', 'enqueued', 'collecting', 'persisted')
			AND created_at >= ?
			ORDER BY received_at ASC
			LIMIT 1`,
		)
		.bind(since)
		.first<{ received_at: string }>();

	const pendingCount = pendingResult?.count ?? 0;
	const processingCount = processingResult?.count ?? 0;
	const failedCount = failedResult?.count ?? 0;

	let queueLagSeconds = 0;
	if (oldestResult?.received_at) {
		const receivedTime = new Date(oldestResult.received_at).getTime() / 1000;
		queueLagSeconds = Math.max(0, now - receivedTime);
	}

		return {
			oldestUnprocessedAt: oldestResult?.received_at,
			queueLagSeconds,
			pendingCount,
			processingCount,
			failedCount,
		};
	});
}

export async function getEntityMetrics(db: D1Database): Promise<EntityMetrics> {
	return getCachedMetrics("entities", async () => {
		const today = new Date().toISOString().split("T")[0];
	const todayStart = `${today}T00:00:00.000Z`;

	const totalResult = await db
		.prepare("SELECT COUNT(*) as count FROM entities_current")
		.first<{ count: number }>();

	const newResult = await db
		.prepare(
			`SELECT COUNT(*) as count FROM entities_current
			WHERE first_seen_at >= ?`,
		)
		.bind(todayStart)
		.first<{ count: number }>();

	const updatedResult = await db
		.prepare(
			`SELECT COUNT(*) as count FROM entities_current
			WHERE last_observed_at >= ?`,
		)
		.bind(todayStart)
		.first<{ count: number }>();

	const bySourceResult = await db
		.prepare(
			`SELECT source_id, COUNT(*) as count
			FROM entities_current
			GROUP BY source_id
			LIMIT 1000`,
		)
		.all<{ source_id: string; count: number }>();

		return {
			totalEntities: totalResult?.count ?? 0,
			newToday: newResult?.count ?? 0,
			updatedToday: updatedResult?.count ?? 0,
			bySource:
				bySourceResult.results?.map((row) => ({
					sourceId: row.source_id,
					count: row.count,
				})) ?? [],
		};
	});
}

export async function getSystemMetrics(
	db: D1Database,
): Promise<SystemMetrics> {
	return getCachedMetrics("system", async () => {
		const since24h = Math.floor(Date.now() / 1000) - 86400;

	const sourcesResult = await db
		.prepare(
			`SELECT
				COUNT(*) as total,
				SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
			FROM source_configs`,
		)
		.first<{ total: number; active: number }>();

	const runsResult = await db
		.prepare(
			`SELECT COUNT(*) as count FROM ingest_runs WHERE created_at >= ?`,
		)
		.bind(since24h)
		.first<{ count: number }>();

	const entitiesResult = await db
		.prepare("SELECT COUNT(*) as count FROM entities_current")
		.first<{ count: number }>();

	const queueMetrics = await getQueueMetrics(db);

	const alertsResult = await db
		.prepare(
			`SELECT
				COUNT(*) as total,
				SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical
			FROM alerts_active WHERE acknowledged = 0`,
		)
		.first<{ total: number; critical: number }>();

		return {
			totalSources: sourcesResult?.total ?? 0,
			activeSources: sourcesResult?.active ?? 0,
			totalRuns24h: runsResult?.count ?? 0,
			totalEntities: entitiesResult?.count ?? 0,
			queueLagSeconds: queueMetrics.queueLagSeconds,
			activeAlerts: alertsResult?.total ?? 0,
			criticalAlerts: alertsResult?.critical ?? 0,
		};
	});
}

/**
 * Optimized D1 SQL aggregation for source metrics across multiple sources.
 * Uses a single GROUP BY query to aggregate all sources at once,
 * with JSON extraction for nested metadata in the database.
 *
 * This is the promptfoo-inspired performance optimization:
 * instead of N queries for N sources, we make 1 query.
 */
export interface AggregatedSourceMetrics {
	sourceId: string;
	totalRuns: number;
	successCount: number;
	failureCount: number;
	normalizedCount: number;
	errorCount: number;
	avgProcessingMs: number | null;
	// JSON-aggregated metadata counts (extracted in SQL)
	metadataCounts: Record<string, number>;
}

export async function getAggregatedSourceMetrics(
	db: D1Database,
	windowSeconds: number = 3600,
	maxResults = 10000,
): Promise<AggregatedSourceMetrics[]> {
	const since = Math.floor(Date.now() / 1000) - windowSeconds;

	// OOM protection: check total result count first
	const countResult = await db
		.prepare(`SELECT COUNT(*) as count FROM ingest_runs WHERE created_at >= ?`)
		.bind(since)
		.first<{ count: number }>();

	if ((countResult?.count ?? 0) > maxResults) {
		throw new Error(
			`Result count ${countResult?.count} exceeds maximum ${maxResults} for metrics aggregation`,
		);
	}

	// Single optimized GROUP BY query aggregating ALL sources at once
	const result = await db
		.prepare(
			`SELECT
				r.source_id,
				COUNT(*) as total_runs,
				SUM(CASE WHEN r.status = 'normalized' THEN 1 ELSE 0 END) as success_count,
				SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) as failure_count,
				SUM(r.normalized_count) as normalized_count,
				SUM(r.error_count) as error_count,
				AVG(
					CASE
						WHEN r.ended_at IS NOT NULL AND r.received_at IS NOT NULL
						THEN unixepoch(r.ended_at) - unixepoch(r.received_at)
						ELSE NULL
					END
				) * 1000 as avg_processing_ms,
				-- JSON aggregation: count occurrences of each trigger type in metadata
				(
					SELECT json_group_object(trigger_type, cnt)
					FROM (
						SELECT
							r2.triggered_by as trigger_type,
							COUNT(*) as cnt
						FROM ingest_runs r2
						WHERE r2.source_id = r.source_id
							AND r2.created_at >= ?
							AND r2.triggered_by IS NOT NULL
						GROUP BY r2.triggered_by
					)
				) as metadata_counts
			FROM ingest_runs r
			WHERE r.created_at >= ?
			GROUP BY r.source_id`,
		)
		.bind(since, since)
		.all<{
			source_id: string;
			total_runs: number;
			success_count: number;
			failure_count: number;
			normalized_count: number;
			error_count: number;
			avg_processing_ms: number | null;
			metadata_counts: string | null;
		}>();

	return (result.results ?? []).map((row) => ({
		sourceId: row.source_id,
		totalRuns: row.total_runs,
		successCount: row.success_count,
		failureCount: row.failure_count,
		normalizedCount: row.normalized_count,
		errorCount: row.error_count,
		avgProcessingMs: row.avg_processing_ms ? Math.round(row.avg_processing_ms) : null,
		metadataCounts: safeJsonParse(row.metadata_counts ?? "{}") ?? {},
	}));
}

// Aggregate metrics into 5-minute windows for historical analysis
export async function aggregateMetricsWindow(
	db: D1Database,
	windowStart: number,
	windowEnd: number,
): Promise<void> {
	// Aggregate per-source metrics for this window
	const results = await db
		.prepare(
			`SELECT
				source_id,
				COUNT(*) as total_runs,
				SUM(CASE WHEN status = 'normalized' THEN 1 ELSE 0 END) as success_count,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failure_count,
				SUM(normalized_count) as normalized_count,
				SUM(error_count) as error_count,
				AVG(
					CASE
						WHEN ended_at IS NOT NULL AND received_at IS NOT NULL
						THEN unixepoch(ended_at) - unixepoch(received_at)
						ELSE NULL
					END
				) as avg_processing_sec
			FROM ingest_runs
			WHERE created_at >= ? AND created_at < ?
			GROUP BY source_id`,
		)
		.bind(windowStart, windowEnd)
		.all<{
			source_id: string;
			total_runs: number;
			success_count: number;
			failure_count: number;
			normalized_count: number;
			error_count: number;
			avg_processing_sec: number | null;
		}>();

	for (const row of results.results ?? []) {
		const metricId = `${row.source_id}:${windowStart}`;
		const avgProcessingMs = row.avg_processing_sec
			? Math.round(row.avg_processing_sec * 1000)
			: null;

		await db
			.prepare(
				`INSERT INTO source_metrics_5min (
					metric_id, source_id, window_start, window_end,
					total_runs, success_count, failure_count,
					normalized_count, error_count, avg_processing_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(metric_id) DO UPDATE SET
					total_runs = excluded.total_runs,
					success_count = excluded.success_count,
					failure_count = excluded.failure_count,
					normalized_count = excluded.normalized_count,
					error_count = excluded.error_count,
					avg_processing_ms = excluded.avg_processing_ms`,
			)
			.bind(
				metricId,
				row.source_id,
				windowStart,
				windowEnd,
				row.total_runs,
				row.success_count,
				row.failure_count,
				row.normalized_count,
				row.error_count,
				avgProcessingMs,
			)
			.run();
	}
}
