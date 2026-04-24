import { afterAll, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import migration0001 from "../../../migrations/0001_control_schema.sql?raw";
import migration0002 from "../../../migrations/0002_source_registry.sql?raw";
import migration0003 from "../../../migrations/0003_entity_plane.sql?raw";
import migration0004 from "../../../migrations/0004_retention_audit.sql?raw";
import migration0005 from "../../../migrations/0005_alerting_metrics.sql?raw";
import migration0006 from "../../../migrations/0006_retry_tracking.sql?raw";
import migration0007 from "../../../migrations/0007_settings_audit.sql?raw";
import migration0008 from "../../../migrations/0008_add_missing_columns.sql?raw";
import migration0009 from "../../../migrations/0009_notification_deliveries.sql?raw";
import migration0010 from "../../../migrations/0010_source_schedules.sql?raw";
import migration0011 from "../../../migrations/0011_error_dedup_hash.sql?raw";
import migration0012 from "../../../migrations/0012_error_occurrence_count.sql?raw";
import migration0013 from "../../../migrations/0013_performance_indexes.sql?raw";
import migration0014 from "../../../migrations/0014_generated_columns.sql?raw";

const migrations = [
	{ name: "0001_control_schema.sql", sql: migration0001 },
	{ name: "0002_source_registry.sql", sql: migration0002 },
	{ name: "0003_entity_plane.sql", sql: migration0003 },
	{ name: "0004_retention_audit.sql", sql: migration0004 },
	{ name: "0005_alerting_metrics.sql", sql: migration0005 },
	{ name: "0006_retry_tracking.sql", sql: migration0006 },
	{ name: "0007_settings_audit.sql", sql: migration0007 },
	{ name: "0008_add_missing_columns.sql", sql: migration0008 },
	{ name: "0009_notification_deliveries.sql", sql: migration0009 },
	{ name: "0010_source_schedules.sql", sql: migration0010 },
	{ name: "0011_error_dedup_hash.sql", sql: migration0011 },
	{ name: "0012_error_occurrence_count.sql", sql: migration0012 },
	{ name: "0013_performance_indexes.sql", sql: migration0013 },
	{ name: "0014_generated_columns.sql", sql: migration0014 },
];

let schemaReady = false;

async function ensureTestSchema(): Promise<void> {
	if (schemaReady) {
		return;
	}

	await env.CONTROL_DB
		.prepare(
			"CREATE TABLE IF NOT EXISTS _test_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
		)
		.run();

	for (const migration of migrations) {
		const applied = await env.CONTROL_DB
			.prepare("SELECT name FROM _test_migrations WHERE name = ?")
			.bind(migration.name)
			.first<{ name: string }>();

		if (applied) {
			continue;
		}

		await applyMigrationSql(migration.sql);
		await env.CONTROL_DB
			.prepare("INSERT INTO _test_migrations (name, applied_at) VALUES (?, unixepoch())")
			.bind(migration.name)
			.run();
	}

	schemaReady = true;
}

async function applyMigrationSql(sql: string): Promise<void> {
	const statements = sql
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);

	for (const statement of statements) {
		try {
			await env.CONTROL_DB.prepare(statement).run();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Ignore duplicate column/table errors — migrations may re-add columns
			// that already exist in newer CREATE TABLE statements
			if (message.includes("duplicate column name") || message.includes("already exists")) {
				continue;
			}
			throw err;
		}
	}
}

beforeAll(async () => {
	await ensureTestSchema();
	console.log("[Integration Tests] Starting test environment");
}, 30000);

afterAll(async () => {
	console.log("[Integration Tests] Cleaning up test environment");
	await new Promise((resolve) => setTimeout(resolve, 100));
});
