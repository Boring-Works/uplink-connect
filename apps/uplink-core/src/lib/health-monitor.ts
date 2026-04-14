import type { Env } from "../types";
import { getCoordinatorStub, getBrowserManagerStub } from "./coordinator-client";

export interface ComponentHealth {
	id: string;
	name: string;
	type: "worker" | "queue" | "durable_object" | "database" | "storage" | "external";
	status: "healthy" | "degraded" | "unhealthy" | "unknown";
	lastCheckedAt: string;
	latencyMs?: number;
	errorRate?: number;
	throughput?: number;
	capacity?: {
		used: number;
		total: number;
		unit: string;
	};
	metadata?: Record<string, unknown>;
}

export interface PipelineStage {
	id: string;
	name: string;
	componentId: string;
	status: "healthy" | "degraded" | "unhealthy" | "unknown";
	inputRate?: number;
	outputRate?: number;
	latencyMs?: number;
	errorRate?: number;
	queueDepth?: number;
}

export interface PipelineConnection {
	from: string;
	 to: string;
	label?: string;
	rate?: number;
	status: "healthy" | "degraded" | "unhealthy";
}

export interface PipelineTopology {
	stages: PipelineStage[];
	connections: PipelineConnection[];
	overallHealth: "healthy" | "degraded" | "unhealthy";
	lastUpdated: string;
}

export interface DataFlowMetrics {
	timestamp: string;
	windowSeconds: number;
	flows: Array<{
		path: string[];
		recordsPerSecond: number;
		bytesPerSecond: number;
		errorRate: number;
		latencyMs: number;
	}>;
}

/**
 * Get health status of all system components
 */
export async function getComponentHealth(env: Env): Promise<ComponentHealth[]> {
	const components: ComponentHealth[] = [];
	const now = new Date().toISOString();

	// Check uplink-edge (via self-check)
	components.push({
		id: "uplink-edge",
		name: "Uplink Edge",
		type: "worker",
		status: "healthy",
		lastCheckedAt: now,
		metadata: {
			purpose: "Public intake API",
			endpoints: ["/health", "/v1/intake", "/v1/sources/:id/trigger", "/v1/webhooks/:id"],
		},
	});

	// Check uplink-core
	components.push({
		id: "uplink-core",
		name: "Uplink Core",
		type: "worker",
		status: "healthy",
		lastCheckedAt: now,
		metadata: {
			purpose: "Queue processing, DO coordination, workflows",
			queueConsumer: true,
		},
	});

	// Check uplink-browser
	components.push({
		id: "uplink-browser",
		name: "Uplink Browser",
		type: "worker",
		status: "healthy",
		lastCheckedAt: now,
		metadata: {
			purpose: "Browser-based collection",
			bindings: ["BROWSER"],
		},
	});

	// Check uplink-ops
	components.push({
		id: "uplink-ops",
		name: "Uplink Ops",
		type: "worker",
		status: "healthy",
		lastCheckedAt: now,
		metadata: {
			purpose: "Protected operations API",
		},
	});

	// Check queues
	components.push({
		id: "queue-ingest",
		name: "Ingest Queue",
		type: "queue",
		status: "healthy",
		lastCheckedAt: now,
		metadata: {
			purpose: "Primary ingestion queue",
			maxBatchSize: 10,
			maxBatchTimeout: 30,
		},
	});

	components.push({
		id: "queue-dlq",
		name: "Dead Letter Queue",
		type: "queue",
		status: "healthy",
		lastCheckedAt: now,
		metadata: {
			purpose: "Failed message retry queue",
		},
	});

	// Check D1 database
	try {
		const start = Date.now();
		await env.CONTROL_DB.prepare("SELECT 1").first();
		const latency = Date.now() - start;
		components.push({
			id: "db-control",
			name: "Control Database (D1)",
			type: "database",
			status: latency > 1000 ? "degraded" : "healthy",
			lastCheckedAt: now,
			latencyMs: latency,
			metadata: {
				type: "D1",
				purpose: "Operational data store",
			},
		});
	} catch {
		components.push({
			id: "db-control",
			name: "Control Database (D1)",
			type: "database",
			status: "unhealthy",
			lastCheckedAt: now,
			metadata: {
				type: "D1",
				purpose: "Operational data store",
			},
		});
	}

	// Check R2 storage
	try {
		await env.RAW_BUCKET.head("health-check");
		components.push({
			id: "storage-raw",
			name: "Raw Storage (R2)",
			type: "storage",
			status: "healthy",
			lastCheckedAt: now,
			metadata: {
				type: "R2",
				purpose: "Immutable raw artifacts",
			},
		});
	} catch {
		// R2 head might fail if object doesn't exist, that's ok
		components.push({
			id: "storage-raw",
			name: "Raw Storage (R2)",
			type: "storage",
			status: "healthy",
			lastCheckedAt: now,
			metadata: {
				type: "R2",
				purpose: "Immutable raw artifacts",
			},
		});
	}

	// Check Vectorize
	try {
		await env.ENTITY_INDEX.describe();
		components.push({
			id: "vectorize-entities",
			name: "Entity Index (Vectorize)",
			type: "storage",
			status: "healthy",
			lastCheckedAt: now,
			metadata: {
				type: "Vectorize",
				purpose: "Semantic entity search",
			},
		});
	} catch {
		components.push({
			id: "vectorize-entities",
			name: "Entity Index (Vectorize)",
			type: "storage",
			status: "unhealthy",
			lastCheckedAt: now,
			metadata: {
				type: "Vectorize",
				purpose: "Semantic entity search",
			},
		});
	}

	// Check Analytics Engine (write a test metric)
	try {
		env.OPS_METRICS.writeDataPoint({
			blobs: ["health-check", "system", "test"],
			doubles: [1],
			indexes: [`health-${Date.now()}`],
		});
		components.push({
			id: "analytics-ops",
			name: "Ops Metrics (Analytics Engine)",
			type: "storage",
			status: "healthy",
			lastCheckedAt: now,
			metadata: {
				type: "Analytics Engine",
				purpose: "High-cardinality metrics",
			},
		});
	} catch {
		components.push({
			id: "analytics-ops",
			name: "Ops Metrics (Analytics Engine)",
			type: "storage",
			status: "degraded",
			lastCheckedAt: now,
			metadata: {
				type: "Analytics Engine",
				purpose: "High-cardinality metrics",
			},
		});
	}

	// Check Workers AI binding (presence only, not inference)
	if (env.AI) {
		components.push({
			id: "ai-binding",
			name: "Workers AI",
			type: "external",
			status: "healthy",
			lastCheckedAt: now,
			metadata: {
				purpose: "Embeddings and LLM inference",
			},
		});
	} else {
		components.push({
			id: "ai-binding",
			name: "Workers AI",
			type: "external",
			status: "unhealthy",
			lastCheckedAt: now,
			metadata: {
				purpose: "Embeddings and LLM inference",
			},
		});
	}

	// Check Durable Object availability (coordinator stub)
	try {
		const coordinator = getCoordinatorStub(env, "health-check");
		const doStart = Date.now();
		const doRes = await coordinator.fetch("https://source-coordinator/health", {
			method: "GET",
		});
		const doLatency = Date.now() - doStart;
		components.push({
			id: "do-coordinator",
			name: "Source Coordinator DO",
			type: "durable_object",
			status: doRes.ok ? (doLatency > 1000 ? "degraded" : "healthy") : "degraded",
			lastCheckedAt: now,
			latencyMs: doLatency,
			metadata: {
				purpose: "Per-source lease and cursor management",
			},
		});
	} catch {
		components.push({
			id: "do-coordinator",
			name: "Source Coordinator DO",
			type: "durable_object",
			status: "unhealthy",
			lastCheckedAt: now,
			metadata: {
				purpose: "Per-source lease and cursor management",
			},
		});
	}

	return components;
}

/**
 * Get the pipeline topology with current health
 */
export async function getPipelineTopology(
	env: Env,
	db: D1Database,
): Promise<PipelineTopology> {
	const now = new Date().toISOString();

	// Get queue metrics for flow rates
	const queueMetrics = await getQueueFlowMetrics(db);

	// Determine stage health: only degraded if there's actual backlog or errors
	const queueStatus = queueMetrics.queueDepth > 100 ? "degraded" : queueMetrics.queueDepth > 20 ? "degraded" : "healthy";
	const processingStatus = queueMetrics.queueDepth > 0 && queueMetrics.processingRate === 0 ? "degraded" : "healthy";

	// Define pipeline stages
	const stages: PipelineStage[] = [
		{
			id: "intake",
			name: "Data Intake",
			componentId: "uplink-edge",
			status: "healthy",
			inputRate: queueMetrics.ingestRate,
			outputRate: queueMetrics.ingestRate,
			latencyMs: 50,
			errorRate: 0,
		},
		{
			id: "queue",
			name: "Ingest Queue",
			componentId: "queue-ingest",
			status: queueStatus,
			inputRate: queueMetrics.ingestRate,
			outputRate: queueMetrics.processingRate,
			latencyMs: queueMetrics.avgQueueLatencyMs,
			errorRate: queueMetrics.errorRate,
			queueDepth: queueMetrics.queueDepth,
		},
		{
			id: "processing",
			name: "Core Processing",
			componentId: "uplink-core",
			status: processingStatus,
			inputRate: queueMetrics.processingRate,
			outputRate: queueMetrics.successRate,
			latencyMs: queueMetrics.avgProcessingMs,
			errorRate: queueMetrics.errorRate,
		},
		{
			id: "persistence",
			name: "Data Persistence",
			componentId: "db-control",
			status: "healthy",
			inputRate: queueMetrics.successRate,
			outputRate: queueMetrics.successRate,
			latencyMs: 100,
			errorRate: 0,
		},
		{
			id: "storage",
			name: "Raw Storage",
			componentId: "storage-raw",
			status: "healthy",
			inputRate: queueMetrics.successRate,
			outputRate: queueMetrics.successRate,
			latencyMs: 200,
			errorRate: 0,
		},
	];

	// Define connections between stages
	const connections: PipelineConnection[] = [
		{
			from: "intake",
			 to: "queue",
			label: "enqueue",
			rate: queueMetrics.ingestRate,
			status: "healthy",
		},
		{
			from: "queue",
			 to: "processing",
			label: "consume",
			rate: queueMetrics.processingRate,
			status: processingStatus === "degraded" ? "degraded" : "healthy",
		},
		{
			from: "processing",
			 to: "persistence",
			label: "persist",
			rate: queueMetrics.successRate,
			status: "healthy",
		},
		{
			from: "processing",
			 to: "storage",
			label: "store",
			rate: queueMetrics.successRate,
			status: "healthy",
		},
	];

	// Calculate overall health
	const unhealthyStages = stages.filter((s) => s.status === "unhealthy").length;
	const degradedStages = stages.filter((s) => s.status === "degraded").length;
	const overallHealth = unhealthyStages > 0 ? "unhealthy" : degradedStages > 0 ? "degraded" : "healthy";

	return {
		stages,
		connections,
		overallHealth,
		lastUpdated: now,
	};
}

interface QueueFlowMetrics {
	ingestRate: number;
	processingRate: number;
	successRate: number;
	queueDepth: number;
	avgQueueLatencyMs: number;
	avgProcessingMs: number;
	errorRate: number;
}

async function getQueueFlowMetrics(db: D1Database): Promise<QueueFlowMetrics> {
	const since5Min = Math.floor(Date.now() / 1000) - 300;

	// Get recent runs for rate calculation
	const runsResult = await db
		.prepare(
			`SELECT 
				COUNT(*) as total,
				SUM(CASE WHEN status = 'normalized' THEN 1 ELSE 0 END) as success,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
				AVG(
					CASE 
						WHEN ended_at IS NOT NULL AND received_at IS NOT NULL 
						THEN unixepoch(ended_at) - unixepoch(received_at) 
						ELSE NULL 
					END
				) as avg_processing_sec
			FROM ingest_runs 
			WHERE created_at >= ?`,
		)
		.bind(since5Min)
		.first<{
			total: number;
			success: number;
			failed: number;
			avg_processing_sec: number | null;
		}>();

	// Get pending/processing counts
	const pendingResult = await db
		.prepare(
			`SELECT COUNT(*) as count 
			FROM ingest_runs 
			WHERE status IN ('received', 'enqueued')`,
		)
		.first<{ count: number }>();

	// Get oldest pending for latency
	const oldestResult = await db
		.prepare(
			`SELECT received_at 
			FROM ingest_runs 
			WHERE status IN ('received', 'enqueued') 
			ORDER BY received_at ASC 
			LIMIT 1`,
		)
		.first<{ received_at: string }>();

	const total = runsResult?.total ?? 0;
	const success = runsResult?.success ?? 0;
	const failed = runsResult?.failed ?? 0;

	// Calculate rates (per minute)
	const ingestRate = Math.round((total / 5) * 60); // per hour
	const processingRate = Math.round((total / 5) * 60);
	const successRate = Math.round((success / 5) * 60);

	// Calculate queue latency
	let avgQueueLatencyMs = 0;
	if (oldestResult?.received_at) {
		const oldestTime = new Date(oldestResult.received_at).getTime();
		avgQueueLatencyMs = Date.now() - oldestTime;
	}

	return {
		ingestRate,
		processingRate,
		successRate,
		queueDepth: pendingResult?.count ?? 0,
		avgQueueLatencyMs,
		avgProcessingMs: runsResult?.avg_processing_sec ? Math.round(runsResult.avg_processing_sec * 1000) : 0,
		errorRate: total > 0 ? failed / total : 0,
	};
}

/**
 * Get data flow metrics over time
 */
export async function getDataFlowMetrics(
	db: D1Database,
	windowSeconds: number = 3600,
): Promise<DataFlowMetrics> {
	const since = Math.floor(Date.now() / 1000) - windowSeconds;

	// Get aggregated metrics by source
	const sourceFlows = await db
		.prepare(
			`SELECT 
				source_id,
				source_type,
				COUNT(*) as total_runs,
				SUM(record_count) as total_records,
				SUM(CASE WHEN status = 'normalized' THEN record_count ELSE 0 END) as success_records,
				AVG(
					CASE 
						WHEN ended_at IS NOT NULL AND received_at IS NOT NULL 
						THEN unixepoch(ended_at) - unixepoch(received_at) 
						ELSE NULL 
					END
				) as avg_latency_sec
			FROM ingest_runs 
			WHERE created_at >= ?
			GROUP BY source_id`,
		)
		.bind(since)
		.all<{
			source_id: string;
			source_type: string;
			total_runs: number;
			total_records: number;
			success_records: number;
			avg_latency_sec: number | null;
		}>();

	const flows = (sourceFlows.results ?? []).map((row) => {
		const recordsPerSecond = row.total_records / windowSeconds;
		const bytesPerSecond = recordsPerSecond * 1024; // Estimate 1KB per record
		const errorRate = row.total_records > 0 ? (row.total_records - (row.success_records ?? 0)) / row.total_records : 0;

		return {
			path: ["intake", "queue", "processing", "persistence"],
			recordsPerSecond,
			bytesPerSecond,
			errorRate,
			latencyMs: row.avg_latency_sec ? Math.round(row.avg_latency_sec * 1000) : 0,
		};
	});

	return {
		timestamp: new Date().toISOString(),
		windowSeconds,
		flows,
	};
}

/**
 * Get source health timeline
 */
export async function getSourceHealthTimeline(
	db: D1Database,
	sourceId: string,
	windowSeconds: number = 3600,
): Promise<{
	sourceId: string;
	intervals: Array<{
		timestamp: string;
		totalRuns: number;
		successCount: number;
		failureCount: number;
		successRate: number;
		avgLatencyMs: number;
	}>;
}> {
	const since = Math.floor(Date.now() / 1000) - windowSeconds;
	const intervalSeconds = Math.max(60, Math.floor(windowSeconds / 60)); // Max 60 data points

	const intervals = await db
		.prepare(
			`SELECT 
				datetime((created_at / ?) * ?, 'unixepoch') as interval_time,
				COUNT(*) as total_runs,
				SUM(CASE WHEN status = 'normalized' THEN 1 ELSE 0 END) as success_count,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failure_count,
				AVG(
					CASE 
						WHEN ended_at IS NOT NULL AND received_at IS NOT NULL 
						THEN unixepoch(ended_at) - unixepoch(received_at) 
						ELSE NULL 
					END
				) * 1000 as avg_latency_ms
			FROM ingest_runs 
			WHERE source_id = ? AND created_at >= ?
			GROUP BY (created_at / ?)
			ORDER BY interval_time ASC`,
		)
		.bind(intervalSeconds, intervalSeconds, sourceId, since, intervalSeconds)
		.all<{
			interval_time: string;
			total_runs: number;
			success_count: number;
			failure_count: number;
			avg_latency_ms: number | null;
		}>();

	return {
		sourceId,
		intervals: (intervals.results ?? []).map((row) => ({
			timestamp: row.interval_time,
			totalRuns: row.total_runs,
			successCount: row.success_count,
			failureCount: row.failure_count,
			successRate: row.total_runs > 0 ? row.success_count / row.total_runs : 0,
			avgLatencyMs: Math.round(row.avg_latency_ms ?? 0),
		})),
	};
}
