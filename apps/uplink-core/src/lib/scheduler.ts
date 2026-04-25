import { ulid } from "@uplink/contracts";

export interface SourceSchedule {
	scheduleId: string;
	sourceId: string;
	cronExpression: string;
	enabled: boolean;
	label?: string;
	createdAt: number;
	updatedAt: number;
}

export interface CreateScheduleInput {
	sourceId: string;
	cronExpression: string;
	enabled?: boolean;
	label?: string;
}

export interface UpdateScheduleInput {
	cronExpression?: string;
	enabled?: boolean;
	label?: string;
}

/**
 * List all source schedules, optionally filtered by source or enabled status
 */
export async function listSourceSchedules(
	db: D1Database,
	filters: { sourceId?: string; enabledOnly?: boolean } = {},
): Promise<SourceSchedule[]> {
	const conditions: string[] = [];
	const values: (string | number)[] = [];

	if (filters.sourceId) {
		conditions.push("source_id = ?");
		values.push(filters.sourceId);
	}
	if (filters.enabledOnly) {
		conditions.push("enabled = 1");
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const result = await db
		.prepare(
			`SELECT schedule_id, source_id, cron_expression, enabled, label, created_at, updated_at
			FROM source_schedules
			${whereClause}
			ORDER BY updated_at DESC`,
		)
		.bind(...values)
		.all<{
			schedule_id: string;
			source_id: string;
			cron_expression: string;
			enabled: number;
			label: string | null;
			created_at: number;
			updated_at: number;
		}>();

	return (result.results ?? []).map((row) => ({
		scheduleId: row.schedule_id,
		sourceId: row.source_id,
		cronExpression: row.cron_expression,
		enabled: row.enabled === 1,
		label: row.label ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}));
}

/**
 * Get a single schedule by ID
 */
export async function getSourceSchedule(
	db: D1Database,
	scheduleId: string,
): Promise<SourceSchedule | null> {
	const row = await db
		.prepare(
			`SELECT schedule_id, source_id, cron_expression, enabled, label, created_at, updated_at
			FROM source_schedules
			WHERE schedule_id = ?`,
		)
		.bind(scheduleId)
		.first<{
			schedule_id: string;
			source_id: string;
			cron_expression: string;
			enabled: number;
			label: string | null;
			created_at: number;
			updated_at: number;
		}>();

	if (!row) return null;

	return {
		scheduleId: row.schedule_id,
		sourceId: row.source_id,
		cronExpression: row.cron_expression,
		enabled: row.enabled === 1,
		label: row.label ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * Create a new source schedule
 */
export async function createSourceSchedule(
	db: D1Database,
	input: CreateScheduleInput,
): Promise<SourceSchedule> {
	const scheduleId = ulid();
	const now = Math.floor(Date.now() / 1000);

	await db
		.prepare(
			`INSERT INTO source_schedules (
				schedule_id, source_id, cron_expression, enabled, label, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			scheduleId,
			input.sourceId,
			input.cronExpression,
			input.enabled !== false ? 1 : 0,
			input.label ?? null,
			now,
			now,
		)
		.run();

	return {
		scheduleId,
		sourceId: input.sourceId,
		cronExpression: input.cronExpression,
		enabled: input.enabled !== false,
		label: input.label,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Update an existing source schedule
 */
export async function updateSourceSchedule(
	db: D1Database,
	scheduleId: string,
	input: UpdateScheduleInput,
): Promise<SourceSchedule | null> {
	const sets: string[] = ["updated_at = ?"];
	const values: (string | number)[] = [Math.floor(Date.now() / 1000)];

	if (input.cronExpression !== undefined) {
		sets.push("cron_expression = ?");
		values.push(input.cronExpression);
	}
	if (input.enabled !== undefined) {
		sets.push("enabled = ?");
		values.push(input.enabled ? 1 : 0);
	}
	if (input.label !== undefined) {
		sets.push("label = ?");
		values.push(input.label ?? null);
	}

	values.push(scheduleId);

	await db
		.prepare(`UPDATE source_schedules SET ${sets.join(", ")} WHERE schedule_id = ?`)
		.bind(...values)
		.run();

	return getSourceSchedule(db, scheduleId);
}

/**
 * Delete a source schedule
 */
export async function deleteSourceSchedule(db: D1Database, scheduleId: string): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM source_schedules WHERE schedule_id = ?")
		.bind(scheduleId)
		.run();

	return result.success && (result.meta?.changes ?? 0) > 0;
}

/**
 * Get all enabled schedules grouped by cron expression.
 * Useful for the scheduled handler to batch trigger sources.
 */
export async function getEnabledSchedulesByCron(
	db: D1Database,
): Promise<Record<string, string[]>> {
	const result = await db
		.prepare(
			`SELECT s.cron_expression, s.source_id
			FROM source_schedules s
			JOIN source_configs c ON c.source_id = s.source_id
			WHERE s.enabled = 1 AND c.deleted_at IS NULL AND c.status = 'active'
			ORDER BY s.cron_expression`,
		)
		.all<{
			cron_expression: string;
			source_id: string;
		}>();

	const grouped: Record<string, string[]> = {};
	for (const row of result.results ?? []) {
		const cron = row.cron_expression;
		if (!grouped[cron]) grouped[cron] = [];
		grouped[cron].push(row.source_id);
	}
	return grouped;
}
