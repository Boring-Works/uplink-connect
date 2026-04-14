import type { D1Database } from "@cloudflare/workers-types";

export interface RunTrace {
	runId: string;
	sourceId: string;
	status: string;
	createdAt: string;
	receivedAt?: string;
	endedAt?: string;
	recordCount: number;
	normalizedCount: number;
	errorCount: number;
	triggeredBy?: string;
	replayOfRunId?: string;
	children: RunTraceChild[];
	errors: RunTraceError[];
	artifacts: RunTraceArtifact[];
}

export interface RunTraceChild {
	runId: string;
	relationship: "replay" | "retry" | "related";
	status: string;
	createdAt: string;
}

export interface RunTraceError {
	errorId: string;
	phase: string;
	errorCode: string;
	errorMessage: string;
	status: string;
	createdAt: string;
}

export interface RunTraceArtifact {
	artifactId: string;
	artifactType: string;
	r2Key: string;
	sizeBytes: number;
}

export interface EntityLineage {
	entityId: string;
	sourceId: string;
	externalId?: string;
	contentHash: string;
	currentState: Record<string, unknown>;
	history: EntityLineageEvent[];
	relationships: EntityRelationship[];
}

export interface EntityLineageEvent {
	eventType: "created" | "updated" | "observed";
	runId: string;
	observedAt: string;
	contentHash: string;
	changes?: Array<{ field: string; oldValue?: unknown; newValue?: unknown }>;
}

export interface EntityRelationship {
	entityId: string;
	relationshipType: string;
	metadata?: Record<string, unknown>;
}

/**
 * Get full trace for a run including replays, retries, errors, and artifacts
 */
export async function getRunTrace(
	db: D1Database,
	runId: string,
): Promise<RunTrace | null> {
	// Get main run
	const run = await db
		.prepare(
			`SELECT 
				run_id, source_id, status, created_at, received_at, ended_at,
				record_count, normalized_count, error_count,
				triggered_by, replay_of_run_id
			FROM ingest_runs 
			WHERE run_id = ?`,
		)
		.bind(runId)
		.first<{
			run_id: string;
			source_id: string;
			status: string;
			created_at: number;
			received_at: string | null;
			ended_at: string | null;
			record_count: number;
			normalized_count: number;
			error_count: number;
			triggered_by: string | null;
			replay_of_run_id: string | null;
		}>();

	if (!run) {
		return null;
	}

	// Get replay children
	const childrenResult = await db
		.prepare(
			`SELECT 
				run_id, status, created_at, replay_of_run_id
			FROM ingest_runs 
			WHERE replay_of_run_id = ?
			ORDER BY created_at DESC`,
		)
		.bind(runId)
		.all<{
			run_id: string;
			status: string;
			created_at: number;
			replay_of_run_id: string | null;
		}>();

	// Get errors for this run
	const errorsResult = await db
		.prepare(
			`SELECT 
				error_id, phase, error_code, error_message, status, created_at
			FROM ingest_errors 
			WHERE run_id = ?
			ORDER BY created_at DESC`,
		)
		.bind(runId)
		.all<{
			error_id: string;
			phase: string;
			error_code: string;
			error_message: string;
			status: string;
			created_at: number;
		}>();

	// Get artifacts
	const artifactsResult = await db
		.prepare(
			`SELECT 
				artifact_id, artifact_type, r2_key, size_bytes
			FROM raw_artifacts 
			WHERE run_id = ?`,
		)
		.bind(runId)
		.all<{
			artifact_id: string;
			artifact_type: string;
			r2_key: string;
			size_bytes: number;
		}>();

	return {
		runId: run.run_id,
		sourceId: run.source_id,
		status: run.status,
		createdAt: new Date(run.created_at * 1000).toISOString(),
		receivedAt: run.received_at ?? undefined,
		endedAt: run.ended_at ?? undefined,
		recordCount: run.record_count,
		normalizedCount: run.normalized_count,
		errorCount: run.error_count,
		triggeredBy: run.triggered_by ?? undefined,
		replayOfRunId: run.replay_of_run_id ?? undefined,
		children: (childrenResult.results ?? []).map((row) => ({
			runId: row.run_id,
			relationship: "replay",
			status: row.status,
			createdAt: new Date(row.created_at * 1000).toISOString(),
		})),
		errors: (errorsResult.results ?? []).map((row) => ({
			errorId: row.error_id,
			phase: row.phase,
			errorCode: row.error_code,
			errorMessage: row.error_message,
			status: row.status,
			createdAt: new Date(row.created_at * 1000).toISOString(),
		})),
		artifacts: (artifactsResult.results ?? []).map((row) => ({
			artifactId: row.artifact_id,
			artifactType: row.artifact_type,
			r2Key: row.r2_key,
			sizeBytes: row.size_bytes,
		})),
	};
}

/**
 * Get entity lineage - full history of an entity
 */
export async function getEntityLineage(
	db: D1Database,
	entityId: string,
): Promise<EntityLineage | null> {
	// Get current entity state
	const entity = await db
		.prepare(
			`SELECT 
				entity_id, source_id, external_id, content_hash, canonical_json
			FROM entities_current 
			WHERE entity_id = ?`,
		)
		.bind(entityId)
		.first<{
			entity_id: string;
			source_id: string;
			external_id: string | null;
			content_hash: string;
			canonical_json: string;
		}>();

	if (!entity) {
		return null;
	}

	// Get observation history
	const historyResult = await db
		.prepare(
			`SELECT 
				run_id, observed_at, content_hash, canonical_json
			FROM entity_observations 
			WHERE entity_id = ?
			ORDER BY observed_at ASC`,
		)
		.bind(entityId)
		.all<{
			run_id: string;
			observed_at: string;
			content_hash: string;
			canonical_json: string;
		}>();

	// Get relationships
	const relationshipsResult = await db
		.prepare(
			`SELECT 
				target_entity_id, relationship_type, metadata_json
			FROM entity_links 
			WHERE source_entity_id = ?`,
		)
		.bind(entityId)
		.all<{
			target_entity_id: string;
			relationship_type: string;
			metadata_json: string | null;
		}>();

	const history = (historyResult.results ?? []);
	const lineageEvents: EntityLineageEvent[] = [];

	for (let i = 0; i < history.length; i++) {
		const event = history[i];
		const prevEvent = i > 0 ? history[i - 1] : null;

		let changes: Array<{ field: string; oldValue?: unknown; newValue?: unknown }> | undefined;

		if (prevEvent) {
			try {
				const current = JSON.parse(event.canonical_json);
				const previous = JSON.parse(prevEvent.canonical_json);
				changes = diffObjects(previous, current);
			} catch {
				// Ignore parse errors
			}
		}

		lineageEvents.push({
			eventType: i === 0 ? "created" : "updated",
			runId: event.run_id,
			observedAt: event.observed_at,
			contentHash: event.content_hash,
			changes,
		});
	}

	return {
		entityId: entity.entity_id,
		sourceId: entity.source_id,
		externalId: entity.external_id ?? undefined,
		contentHash: entity.content_hash,
		currentState: safeJsonParse(entity.canonical_json, {}),
		history: lineageEvents,
		relationships: (relationshipsResult.results ?? []).map((row) => ({
			entityId: row.target_entity_id,
			relationshipType: row.relationship_type,
			metadata: safeJsonParse(row.metadata_json, {}),
		})),
	};
}

/**
 * Get run tree for a source - visual hierarchy of runs and replays
 */
export async function getSourceRunTree(
	db: D1Database,
	sourceId: string,
	limit: number = 50,
): Promise<{
	sourceId: string;
	tree: Array<{
		runId: string;
		status: string;
		createdAt: string;
		recordCount: number;
		children: Array<{
			runId: string;
			status: string;
			createdAt: string;
			recordCount: number;
		}>;
	}>;
}> {
	// Get root runs (not replays) for this source
	const rootRuns = await db
		.prepare(
			`SELECT 
				run_id, status, created_at, record_count
			FROM ingest_runs 
			WHERE source_id = ? AND replay_of_run_id IS NULL
			ORDER BY created_at DESC
			LIMIT ?`,
		)
		.bind(sourceId, limit)
		.all<{
			run_id: string;
			status: string;
			created_at: number;
			record_count: number;
		}>();

	const tree = [];

	for (const root of rootRuns.results ?? []) {
		// Get children (replays) for this run
		const children = await db
			.prepare(
				`SELECT 
					run_id, status, created_at, record_count
				FROM ingest_runs 
				WHERE replay_of_run_id = ?
				ORDER BY created_at ASC`,
			)
			.bind(root.run_id)
			.all<{
				run_id: string;
				status: string;
				created_at: number;
				record_count: number;
			}>();

		tree.push({
			runId: root.run_id,
			status: root.status,
			createdAt: new Date(root.created_at * 1000).toISOString(),
			recordCount: root.record_count,
			children: (children.results ?? []).map((child) => ({
				runId: child.run_id,
				status: child.status,
				createdAt: new Date(child.created_at * 1000).toISOString(),
				recordCount: child.record_count,
			})),
		});
	}

	return { sourceId, tree };
}

function diffObjects(
	previous: Record<string, unknown>,
	current: Record<string, unknown>,
): Array<{ field: string; oldValue?: unknown; newValue?: unknown }> {
	const changes: Array<{ field: string; oldValue?: unknown; newValue?: unknown }> = [];
	const allKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);

	for (const key of allKeys) {
		const oldValue = previous[key];
		const newValue = current[key];
		if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
			changes.push({ field: key, oldValue, newValue });
		}
	}

	return changes;
}

function safeJsonParse<T>(json: string | null, fallback: T): T {
	if (!json) return fallback;
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
}
