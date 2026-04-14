import {
	SourceConfigSchema,
	SourcePolicySchema,
	safeJsonStringify,
	type IngestEnvelope,
	type SourceConfig,
	type SourcePolicy,
	type ErrorStatus,
	type ErrorListItem,
	type ErrorFilter,
	type RetryAttempt,
} from "@uplink/contracts";
import type { NormalizedEntity } from "@uplink/normalizers";
import type { RuntimeSnapshot } from "../types";
import { classifyError } from "./retry";

export async function upsertSourceConfig(db: D1Database, source: SourceConfig): Promise<void> {
	const parsed = SourceConfigSchema.parse(source);

	await db.prepare(
		`INSERT INTO source_configs (
			source_id, name, type, status, adapter_type, endpoint_url,
			request_method, request_headers_json, request_body, metadata_json,
			webhook_security_json, deleted_at, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(source_id) DO UPDATE SET
			name = excluded.name,
			type = excluded.type,
			status = excluded.status,
			adapter_type = excluded.adapter_type,
			endpoint_url = excluded.endpoint_url,
			request_method = excluded.request_method,
			request_headers_json = excluded.request_headers_json,
			request_body = excluded.request_body,
			metadata_json = excluded.metadata_json,
			webhook_security_json = excluded.webhook_security_json,
			updated_at = unixepoch()`,
	)
		.bind(
			parsed.sourceId,
			parsed.name,
			parsed.type,
			parsed.status,
			parsed.adapterType,
			parsed.endpointUrl ?? null,
			parsed.requestMethod,
		safeJsonStringify(parsed.requestHeaders),
		parsed.requestBody ?? null,
		safeJsonStringify(parsed.metadata),
		parsed.webhookSecurity ? safeJsonStringify(parsed.webhookSecurity) : null,
			null,
		)
		.run();

	await db.prepare(
		`INSERT INTO source_policies (
			source_id, min_interval_seconds, lease_ttl_seconds, max_records_per_run,
			retry_limit, timeout_seconds, alert_config_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(source_id) DO UPDATE SET
			min_interval_seconds = excluded.min_interval_seconds,
			lease_ttl_seconds = excluded.lease_ttl_seconds,
			max_records_per_run = excluded.max_records_per_run,
			retry_limit = excluded.retry_limit,
			timeout_seconds = excluded.timeout_seconds,
			alert_config_json = excluded.alert_config_json,
			updated_at = unixepoch()`,
	)
		.bind(
			parsed.sourceId,
			parsed.policy.minIntervalSeconds,
			parsed.policy.leaseTtlSeconds,
			parsed.policy.maxRecordsPerRun,
			parsed.policy.retryLimit,
			parsed.policy.timeoutSeconds,
		parsed.policy.alertConfiguration
			? safeJsonStringify(parsed.policy.alertConfiguration)
			: null,
		)
		.run();

	await db.prepare(
		`INSERT INTO source_capabilities (
			source_id, allow_api, allow_webhook, allow_browser, allow_manual_trigger,
			supports_cursor, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(source_id) DO UPDATE SET
			allow_api = excluded.allow_api,
			allow_webhook = excluded.allow_webhook,
			allow_browser = excluded.allow_browser,
			allow_manual_trigger = excluded.allow_manual_trigger,
			supports_cursor = excluded.supports_cursor,
			updated_at = unixepoch()`,
	)
		.bind(
			parsed.sourceId,
			parsed.type === "api" ? 1 : 0,
			parsed.type === "webhook" ? 1 : 0,
			parsed.type === "browser" ? 1 : 0,
			1,
			0,
		)
		.run();
}

export async function getSourceConfigWithPolicy(
	db: D1Database,
	sourceId: string,
): Promise<{ config: SourceConfig; policy: SourcePolicy } | null> {
	const row = await db
		.prepare(
			`SELECT
				s.source_id,
				s.name,
				s.type,
				s.status,
				s.adapter_type,
				s.endpoint_url,
				s.request_method,
				s.request_headers_json,
				s.request_body,
				s.metadata_json,
				p.min_interval_seconds,
				p.lease_ttl_seconds,
				p.max_records_per_run,
				p.retry_limit,
				p.timeout_seconds,
				p.alert_config_json
			FROM source_configs s
			LEFT JOIN source_policies p ON p.source_id = s.source_id
			WHERE s.source_id = ?`,
		)
		.bind(sourceId)
		.first<{
			source_id: string;
			name: string;
			type: string;
			status: string;
			adapter_type: string;
			endpoint_url: string | null;
			request_method: "GET" | "POST";
			request_headers_json: string;
			request_body: string | null;
			metadata_json: string;
			min_interval_seconds: number | null;
			lease_ttl_seconds: number | null;
			max_records_per_run: number | null;
			retry_limit: number | null;
			timeout_seconds: number | null;
			alert_config_json: string | null;
		}>();

	if (!row) {
		return null;
	}

	const alertConfiguration = row.alert_config_json
		? (JSON.parse(row.alert_config_json) as SourcePolicy["alertConfiguration"])
		: undefined;

	const policy = SourcePolicySchema.parse({
		minIntervalSeconds: row.min_interval_seconds ?? 60,
		leaseTtlSeconds: row.lease_ttl_seconds ?? 300,
		maxRecordsPerRun: row.max_records_per_run ?? 1000,
		retryLimit: row.retry_limit ?? 3,
		timeoutSeconds: row.timeout_seconds ?? 60,
		alertConfiguration,
	});

	const config = SourceConfigSchema.parse({
		sourceId: row.source_id,
		name: row.name,
		type: row.type,
		status: row.status,
		adapterType: row.adapter_type,
		endpointUrl: row.endpoint_url ?? undefined,
		requestMethod: row.request_method,
		requestHeaders: parseJsonRecord(row.request_headers_json),
		requestBody: row.request_body ?? undefined,
		metadata: parseJsonRecord(row.metadata_json),
		policy,
	});

	return { config, policy };
}

export interface PaginationParams {
	limit?: number;
	offset?: number;
	cursor?: string;
}

export interface PaginatedResult<T> {
	items: T[];
	total: number;
	nextCursor?: string;
	hasMore: boolean;
}

export async function listRuns(
	db: D1Database,
	params: PaginationParams = {},
): Promise<PaginatedResult<Record<string, unknown>>> {
	const limit = Math.max(1, Math.min(params.limit ?? 50, 500));
	const offset = Math.max(0, params.offset ?? 0);

	const countResult = await db
		.prepare("SELECT COUNT(*) as total FROM ingest_runs")
		.first<{ total: number }>();

	const result = await db
		.prepare(
			`SELECT run_id, source_id, source_name, source_type, status, record_count,
			normalized_count, error_count, workflow_instance_id, triggered_by,
			replay_of_run_id, collected_at, received_at, ended_at, updated_at
			FROM ingest_runs
			ORDER BY created_at DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(limit, offset)
		.all<Record<string, unknown>>();

	const total = countResult?.total ?? 0;
	const hasMore = offset + result.results.length < total;
	const nextCursor = hasMore ? String(offset + result.results.length) : undefined;

	return {
		items: result.results,
		total,
		nextCursor,
		hasMore,
	};
}

export async function getRun(db: D1Database, runId: string): Promise<Record<string, unknown> | null> {
	const row = await db
		.prepare(
			`SELECT run_id, source_id, source_name, source_type, status, record_count,
			normalized_count, error_count, workflow_instance_id, triggered_by,
			replay_of_run_id, collected_at, received_at, ended_at, updated_at,
			envelope_json, artifact_key
			FROM ingest_runs
			WHERE run_id = ?`,
		)
		.bind(runId)
		.first<Record<string, unknown>>();

	return row ?? null;
}

export async function getArtifact(db: D1Database, artifactId: string): Promise<Record<string, unknown> | null> {
	const row = await db
		.prepare(
			`SELECT artifact_id, run_id, source_id, artifact_type, r2_key, size_bytes, created_at
			FROM raw_artifacts
			WHERE artifact_id = ?`,
		)
		.bind(artifactId)
		.first<Record<string, unknown>>();

	return row ?? null;
}

export async function softDeleteSource(db: D1Database, sourceId: string): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE source_configs
			SET deleted_at = unixepoch(), status = 'deleted', updated_at = unixepoch()
			WHERE source_id = ? AND deleted_at IS NULL`,
		)
		.bind(sourceId)
		.run();

	return result.success && (result.meta?.changes ?? 0) > 0;
}

export async function restoreSource(db: D1Database, sourceId: string): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE source_configs
			SET deleted_at = NULL, status = 'active', updated_at = unixepoch()
			WHERE source_id = ? AND deleted_at IS NOT NULL`,
		)
		.bind(sourceId)
		.run();

	return result.success && (result.meta?.changes ?? 0) > 0;
}

export async function permanentlyDeleteSource(db: D1Database, sourceId: string): Promise<boolean> {
	// Delete in dependency order
	await db.prepare("DELETE FROM source_capabilities WHERE source_id = ?").bind(sourceId).run();
	await db.prepare("DELETE FROM source_policies WHERE source_id = ?").bind(sourceId).run();
	await db.prepare("DELETE FROM source_runtime_snapshots WHERE source_id = ?").bind(sourceId).run();
	const result = await db.prepare("DELETE FROM source_configs WHERE source_id = ?").bind(sourceId).run();

	return result.success && (result.meta?.changes ?? 0) > 0;
}

export async function listSources(
	db: D1Database,
	params: PaginationParams & { includeDeleted?: boolean } = {},
): Promise<PaginatedResult<Record<string, unknown>>> {
	const limit = Math.max(1, Math.min(params.limit ?? 50, 500));
	const offset = Math.max(0, params.offset ?? 0);
	const whereClause = params.includeDeleted ? "" : "WHERE deleted_at IS NULL";

	const countResult = await db
		.prepare(`SELECT COUNT(*) as total FROM source_configs ${whereClause}`)
		.first<{ total: number }>();

	const result = await db
		.prepare(
			`SELECT source_id, name, type, status, adapter_type, endpoint_url,
			deleted_at, updated_at
			FROM source_configs
			${whereClause}
			ORDER BY updated_at DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(limit, offset)
		.all<Record<string, unknown>>();

	const total = countResult?.total ?? 0;
	const hasMore = offset + result.results.length < total;
	const nextCursor = hasMore ? String(offset + result.results.length) : undefined;

	return {
		items: result.results,
		total,
		nextCursor,
		hasMore,
	};
}

export async function setRunStatus(
	db: D1Database,
	runId: string,
	status: string,
	extra?: {
		normalizedCount?: number;
		errorCount?: number;
		artifactKey?: string;
		workflowInstanceId?: string;
		endedAt?: string;
		errorMessage?: string;
	},
): Promise<void> {
	const sets: string[] = ["status = ?", "updated_at = unixepoch()"];
	const values: (string | number | null)[] = [status];

	if (extra?.normalizedCount !== undefined) {
		sets.push("normalized_count = ?");
		values.push(extra.normalizedCount);
	}
	if (extra?.errorCount !== undefined) {
		sets.push("error_count = ?");
		values.push(extra.errorCount);
	}
	if (extra?.artifactKey !== undefined) {
		sets.push("artifact_key = ?");
		values.push(extra.artifactKey);
	}
	if (extra?.workflowInstanceId !== undefined) {
		sets.push("workflow_instance_id = ?");
		values.push(extra.workflowInstanceId);
	}
	if (extra?.endedAt !== undefined) {
		sets.push("ended_at = ?");
		values.push(extra.endedAt);
	}
	if (extra?.errorMessage !== undefined) {
		sets.push("error_message = ?");
		values.push(extra.errorMessage);
	}

	values.push(runId);

	await db.prepare(`UPDATE ingest_runs SET ${sets.join(", ")} WHERE run_id = ?`)
		.bind(...values)
		.run();
}

export async function insertRunIfMissing(
	db: D1Database,
	params: {
		runId: string;
		sourceId: string;
		sourceName: string;
		sourceType: string;
		status: string;
		collectedAt: string;
		receivedAt: string;
		recordCount: number;
		envelope: IngestEnvelope;
		workflowInstanceId?: string;
		triggeredBy?: string;
		replayOfRunId?: string;
	},
): Promise<void> {
	await db.prepare(
		`INSERT INTO ingest_runs (
			run_id, source_id, source_name, source_type, status,
			collected_at, received_at, record_count, workflow_instance_id,
			triggered_by, replay_of_run_id, envelope_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(run_id) DO UPDATE SET
			source_id = excluded.source_id,
			source_name = excluded.source_name,
			source_type = excluded.source_type,
			collected_at = excluded.collected_at,
			received_at = excluded.received_at,
			record_count = excluded.record_count,
			replay_of_run_id = COALESCE(excluded.replay_of_run_id, ingest_runs.replay_of_run_id),
			envelope_json = excluded.envelope_json,
			updated_at = unixepoch()
		WHERE ingest_runs.status IN ('collecting', 'received', 'enqueued', 'replayed')`,
	)
		.bind(
			params.runId,
			params.sourceId,
			params.sourceName,
			params.sourceType,
			params.status,
			params.collectedAt,
			params.receivedAt,
			params.recordCount,
			params.workflowInstanceId ?? null,
			params.triggeredBy ?? null,
			params.replayOfRunId ?? null,
			safeJsonStringify(params.envelope),
		)
		.run();
}

function cleanErrorMessage(message: string): string {
	return message
		.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<TIMESTAMP>")
		.replace(/:\d{4,5}\b/g, ":<PORT>")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
		.replace(/\b0x[0-9a-f]+\b/gi, "<HEX>")
		.replace(/\d+/g, "<N>");
}

async function hashError(params: {
	phase: string;
	errorCode: string;
	errorMessage: string;
	sourceId?: string;
}): Promise<string> {
	const cleaned = cleanErrorMessage(params.errorMessage);
	const input = `${params.phase}::${params.errorCode}::${params.sourceId ?? ""}::${cleaned}`;
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(input));
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32);
}

export async function recordIngestError(
	db: D1Database,
	params: {
		runId?: string;
		sourceId?: string;
		phase: string;
		errorCode: string;
		errorMessage: string;
		payload?: string;
		status?: ErrorStatus;
		retryCount?: number;
		errorCategory?: string;
		retryAttempts?: RetryAttempt[];
	},
): Promise<string> {
	const errorId = crypto.randomUUID();
	const classification = classifyError(new Error(params.errorMessage));
	const errorHash = await hashError(params);

	// Try to increment occurrence count for existing unresolved error with same hash
	const updateResult = await db.prepare(
		`UPDATE ingest_errors SET
			occurrence_count = occurrence_count + 1,
			updated_at = unixepoch(),
			last_retry_at = COALESCE(?, last_retry_at),
			retry_count = COALESCE(?, retry_count)
		WHERE error_hash = ? AND status IN ('pending', 'retrying')
		RETURNING error_id`
	)
		.bind(
			params.retryCount != null ? Date.now() / 1000 : null,
			params.retryCount ?? null,
			errorHash,
		)
		.first<{ error_id: string }>();

	if (updateResult) {
		return updateResult.error_id;
	}

	await db.prepare(
		`INSERT INTO ingest_errors (
			error_id, run_id, source_id, phase, error_code, error_message, error_hash,
			payload, status, retry_count, max_retries, error_category, retry_attempts_json,
			occurrence_count, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
	)
		.bind(
			errorId,
			params.runId ?? null,
			params.sourceId ?? null,
			params.phase,
			params.errorCode,
			params.errorMessage,
			errorHash,
			params.payload ?? null,
			params.status ?? "pending",
			params.retryCount ?? 0,
			3, // default max_retries
			params.errorCategory ?? classification.errorCategory,
			safeJsonStringify(params.retryAttempts ?? []),
			1,
		)
		.run();

	return errorId;
}

export async function updateErrorRetryState(
	db: D1Database,
	errorId: string,
	updates: {
		status?: ErrorStatus;
		retryCount?: number;
		lastRetryAt?: number;
		retryAttempts?: RetryAttempt[];
		resolvedAt?: number;
		resolvedBy?: string;
		resolutionNotes?: string;
	},
): Promise<void> {
	const sets: string[] = ["updated_at = unixepoch()"];
	const values: (string | number | null)[] = [];

	if (updates.status !== undefined) {
		sets.push("status = ?");
		values.push(updates.status);
	}
	if (updates.retryCount !== undefined) {
		sets.push("retry_count = ?");
		values.push(updates.retryCount);
	}
	if (updates.lastRetryAt !== undefined) {
		sets.push("last_retry_at = ?");
		values.push(updates.lastRetryAt);
	}
	if (updates.retryAttempts !== undefined) {
		sets.push("retry_attempts_json = ?");
		values.push(safeJsonStringify(updates.retryAttempts));
	}
	if (updates.resolvedAt !== undefined) {
		sets.push("resolved_at = ?");
		values.push(updates.resolvedAt);
	}
	if (updates.resolvedBy !== undefined) {
		sets.push("resolved_by = ?");
		values.push(updates.resolvedBy);
	}
	if (updates.resolutionNotes !== undefined) {
		sets.push("resolution_notes = ?");
		values.push(updates.resolutionNotes);
	}

	values.push(errorId);

	await db.prepare(`UPDATE ingest_errors SET ${sets.join(", ")} WHERE error_id = ?`)
		.bind(...values)
		.run();
}

export async function getIngestError(
	db: D1Database,
	errorId: string,
): Promise<Record<string, unknown> | null> {
	const row = await db
		.prepare(
			`SELECT error_id, run_id, source_id, phase, error_code, error_message, error_hash,
			payload, status, retry_count, max_retries, error_category, retry_attempts_json,
			last_retry_at, created_at, resolved_at, resolved_by, resolution_notes, occurrence_count
			FROM ingest_errors
			WHERE error_id = ?`,
		)
		.bind(errorId)
		.first<Record<string, unknown>>();

	return row ?? null;
}

export async function listIngestErrors(
	db: D1Database,
	filter: ErrorFilter,
): Promise<{ errors: ErrorListItem[]; total: number }> {
	const conditions: string[] = [];
	const values: (string | number | null)[] = [];

	if (filter.status) {
		conditions.push("status = ?");
		values.push(filter.status);
	}
	if (filter.sourceId) {
		conditions.push("source_id = ?");
		values.push(filter.sourceId);
	}
	if (filter.phase) {
		conditions.push("phase = ?");
		values.push(filter.phase);
	}
	if (filter.errorCategory) {
		conditions.push("error_category = ?");
		values.push(filter.errorCategory);
	}
	if (filter.fromDate) {
		conditions.push("created_at >= ?");
		values.push(Math.floor(new Date(filter.fromDate).getTime() / 1000));
	}
	if (filter.toDate) {
		conditions.push("created_at <= ?");
		values.push(Math.floor(new Date(filter.toDate).getTime() / 1000));
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	// Get total count
	const countResult = await db
		.prepare(`SELECT COUNT(*) as total FROM ingest_errors ${whereClause}`)
		.bind(...values)
		.first<{ total: number }>();

	// Get paginated results
	const limit = filter.limit ?? 50;
	const offset = filter.offset ?? 0;

	const result = await db
		.prepare(
			`SELECT error_id, run_id, source_id, phase, error_code, error_message,
			status, retry_count, last_retry_at, created_at, occurrence_count,
			CASE WHEN LENGTH(payload) > 200 THEN SUBSTR(payload, 1, 200) || '...' ELSE payload END as payload_preview
			FROM ingest_errors
			${whereClause}
			ORDER BY created_at DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(...values, limit, offset)
		.all<{
			error_id: string;
			run_id: string | null;
			source_id: string | null;
			phase: string;
			error_code: string;
			error_message: string;
			status: ErrorStatus;
			retry_count: number;
			last_retry_at: number | null;
			created_at: number;
			occurrence_count: number;
			payload_preview: string | null;
		}>();

	const errors: ErrorListItem[] = (result.results ?? []).map((row) => ({
		errorId: row.error_id,
		runId: row.run_id,
		sourceId: row.source_id,
		phase: row.phase,
		errorCode: row.error_code,
		errorMessage: row.error_message,
		status: row.status,
		retryCount: row.retry_count,
		occurrenceCount: row.occurrence_count,
		lastRetryAt: row.last_retry_at ? new Date(row.last_retry_at * 1000).toISOString() : null,
		createdAt: new Date(row.created_at * 1000).toISOString(),
		payloadPreview: row.payload_preview ?? undefined,
	}));

	return {
		errors,
		total: countResult?.total ?? 0,
	};
}

export async function checkIdempotencyKey(
	db: D1Database,
	idempotencyKey: string,
): Promise<{ exists: boolean; result?: string }> {
	const row = await db
		.prepare("SELECT result FROM retry_idempotency_keys WHERE idempotency_key = ?")
		.bind(idempotencyKey)
		.first<{ result: string }>();

	if (!row) {
		return { exists: false };
	}

	return { exists: true, result: row.result };
}

export async function recordIdempotencyKey(
	db: D1Database,
	idempotencyKey: string,
	errorId: string,
	result: string,
): Promise<void> {
	await db.prepare(
		`INSERT INTO retry_idempotency_keys (idempotency_key, error_id, result, attempted_at)
		VALUES (?, ?, ?, unixepoch())
		ON CONFLICT(idempotency_key) DO UPDATE SET
			result = excluded.result,
			attempted_at = unixepoch()`,
	)
		.bind(idempotencyKey, errorId, result)
		.run();
}

export async function cleanupOldIdempotencyKeys(
	db: D1Database,
	olderThanHours: number,
): Promise<number> {
	const result = await db.prepare(
		`DELETE FROM retry_idempotency_keys
		WHERE attempted_at < unixepoch() - (? * 3600)`,
	)
		.bind(olderThanHours)
		.run();

	return result.meta?.changes ?? 0;
}

export async function upsertRuntimeSnapshot(db: D1Database, snapshot: RuntimeSnapshot): Promise<void> {
	await db.prepare(
		`INSERT INTO source_runtime_snapshots (
			source_id, lease_owner, lease_token, lease_expires_at, cursor, next_allowed_at,
			consecutive_failures, last_run_id, last_success_at, last_error_at, last_error_message, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
		ON CONFLICT(source_id) DO UPDATE SET
			lease_owner = excluded.lease_owner,
			lease_token = excluded.lease_token,
			lease_expires_at = excluded.lease_expires_at,
			cursor = excluded.cursor,
			next_allowed_at = excluded.next_allowed_at,
			consecutive_failures = excluded.consecutive_failures,
			last_run_id = excluded.last_run_id,
			last_success_at = excluded.last_success_at,
			last_error_at = excluded.last_error_at,
			last_error_message = excluded.last_error_message,
			updated_at = unixepoch()`,
	)
		.bind(
			snapshot.sourceId,
			snapshot.leaseOwner ?? null,
			snapshot.leaseToken ?? null,
			snapshot.leaseExpiresAt ?? null,
			snapshot.cursor ?? null,
			snapshot.nextAllowedAt ?? null,
			snapshot.consecutiveFailures,
			snapshot.lastRunId ?? null,
			snapshot.lastSuccessAt ?? null,
			snapshot.lastErrorAt ?? null,
			snapshot.lastErrorMessage ?? null,
		)
		.run();
}

const D1_BATCH_SIZE = 90; // D1 hard limit is 100; stay well under it

function chunkArray<T>(arr: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
}

export async function upsertNormalizedEntities(
	db: D1Database,
	runId: string,
	entities: NormalizedEntity[],
): Promise<void> {
	if (entities.length === 0) return;

	const statements: D1PreparedStatement[] = [];
	for (const entity of entities) {
		statements.push(
			db.prepare(
				`INSERT INTO entities_current (
					entity_id, source_id, source_type, external_id, content_hash,
					canonical_json, first_seen_at, last_observed_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
				ON CONFLICT(entity_id) DO UPDATE SET
					source_id = excluded.source_id,
					source_type = excluded.source_type,
					external_id = excluded.external_id,
					content_hash = excluded.content_hash,
					canonical_json = excluded.canonical_json,
					last_observed_at = excluded.last_observed_at,
					updated_at = unixepoch()`,
			)
				.bind(
					entity.entityId,
					entity.sourceId,
					entity.sourceType,
					entity.externalId ?? null,
					entity.contentHash,
					entity.canonicalJson,
					entity.observedAt,
					entity.observedAt,
				),
			db.prepare(
				`INSERT INTO entity_observations (
					observation_id, run_id, entity_id, source_id, content_hash,
					observed_at, payload_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
			)
				.bind(
					crypto.randomUUID(),
					runId,
					entity.entityId,
					entity.sourceId,
					entity.contentHash,
					entity.observedAt,
					entity.canonicalJson,
				),
		);
	}

	if (typeof db.batch === "function") {
		const chunks = chunkArray(statements, D1_BATCH_SIZE);
		for (const chunk of chunks) {
			await db.batch(chunk);
		}
	} else {
		// Fallback for environments without batch support (e.g., test mocks)
		for (const stmt of statements) {
			await stmt.run();
		}
	}
}

function parseJsonRecord(input: string): Record<string, unknown> {
	try {
		const value = JSON.parse(input);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {
		// noop
	}

	return {};
}
