import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

interface ExportOptions {
	sourceId?: string;
	startDate?: string;
	endDate?: string;
	status?: string;
	format: "json" | "csv" | "ndjson";
	limit?: number;
}

app.get("/internal/export/runs", async (c) => {
	const sourceId = c.req.query("sourceId");
	const startDate = c.req.query("startDate");
	const endDate = c.req.query("endDate");
	const status = c.req.query("status");
	const format = (c.req.query("format") ?? "json") as ExportOptions["format"];
	const limitRaw = c.req.query("limit") ?? "10000";
	const limit = Number.parseInt(limitRaw, 10);
	const effectiveLimit = Number.isFinite(limit) ? Math.min(limit, 50000) : 10000;

	let sql = `
		SELECT
			run_id,
			source_id,
			source_name,
			source_type,
			status,
			record_count,
			normalized_count,
			error_count,
			error_message,
			triggered_by,
			collected_at,
			received_at,
			ended_at,
			created_at
		FROM ingest_runs
		WHERE 1=1
	`;
	const params: (string | number)[] = [];

	if (sourceId) {
		sql += " AND source_id = ?";
		params.push(sourceId);
	}
	if (startDate) {
		sql += " AND created_at >= unixepoch(?)";
		params.push(startDate);
	}
	if (endDate) {
		sql += " AND created_at <= unixepoch(?)";
		params.push(endDate);
	}
	if (status) {
		sql += " AND status = ?";
		params.push(status);
	}
	sql += " ORDER BY created_at DESC LIMIT ?";
	params.push(effectiveLimit);

	const stmt = c.env.CONTROL_DB.prepare(sql).bind(...params);
	const { results } = await stmt.all();

	if (format === "csv") {
		const rows = results ?? [];
		const headers = [
			"run_id",
			"source_id",
			"source_name",
			"source_type",
			"status",
			"record_count",
			"normalized_count",
			"error_count",
			"error_message",
			"triggered_by",
			"collected_at",
			"received_at",
			"ended_at",
			"created_at",
		];
		const csvRows = rows.map((row) => {
			const r = row as Record<string, unknown>;
			return headers.map((h) => {
				const val = r[h];
				if (val == null) return "";
				const str = String(val);
				if (str.includes(",") || str.includes('"') || str.includes("\n")) {
					return `"${str.replace(/"/g, '""')}"`;
				}
				return str;
			}).join(",");
		});
		const csv = [headers.join(","), ...csvRows].join("\n");
		c.header("Content-Type", "text/csv");
		c.header("Content-Disposition", 'attachment; filename="uplink-runs.csv"');
		return c.body(csv);
	}

	if (format === "ndjson") {
		const lines = (results ?? [])
			.map((row) => JSON.stringify(row))
			.join("\n");
		c.header("Content-Type", "application/x-ndjson");
		c.header("Content-Disposition", 'attachment; filename="uplink-runs.ndjson"');
		return c.body(lines);
	}

	return c.json({
		meta: {
			count: results?.length ?? 0,
			format: "json",
			limit: effectiveLimit,
		},
		data: results ?? [],
	});
});

app.get("/internal/export/entities", async (c) => {
	const sourceId = c.req.query("sourceId");
	const entityType = c.req.query("entityType");
	const format = (c.req.query("format") ?? "json") as ExportOptions["format"];
	const limitRaw = c.req.query("limit") ?? "10000";
	const limit = Number.parseInt(limitRaw, 10);
	const effectiveLimit = Number.isFinite(limit) ? Math.min(limit, 50000) : 10000;

	let sql = `
		SELECT
			entity_id,
			source_id,
			external_id,
			content_hash,
			observed_at,
			canonical_json,
			updated_at
		FROM entities_current
		WHERE 1=1
	`;
	const params: (string | number)[] = [];

	if (sourceId) {
		sql += " AND source_id = ?";
		params.push(sourceId);
	}
	if (entityType) {
		sql += " AND entity_type = ?";
		params.push(entityType);
	}
	sql += " ORDER BY updated_at DESC LIMIT ?";
	params.push(effectiveLimit);

	const stmt = c.env.CONTROL_DB.prepare(sql).bind(...params);
	const { results } = await stmt.all();

	if (format === "csv") {
		const rows = results ?? [];
		const headers = [
			"entity_id",
			"source_id",
			"external_id",
			"content_hash",
			"observed_at",
			"canonical_json",
			"updated_at",
		];
		const csvRows = rows.map((row) => {
			const r = row as Record<string, unknown>;
			return headers.map((h) => {
				const val = r[h];
				if (val == null) return "";
				const str = String(val);
				if (str.includes(",") || str.includes('"') || str.includes("\n")) {
					return `"${str.replace(/"/g, '""')}"`;
				}
				return str;
			}).join(",");
		});
		const csv = [headers.join(","), ...csvRows].join("\n");
		c.header("Content-Type", "text/csv");
		c.header("Content-Disposition", 'attachment; filename="uplink-entities.csv"');
		return c.body(csv);
	}

	if (format === "ndjson") {
		const lines = (results ?? [])
			.map((row) => JSON.stringify(row))
			.join("\n");
		c.header("Content-Type", "application/x-ndjson");
		c.header("Content-Disposition", 'attachment; filename="uplink-entities.ndjson"');
		return c.body(lines);
	}

	return c.json({
		meta: {
			count: results?.length ?? 0,
			format: "json",
			limit: effectiveLimit,
		},
		data: results ?? [],
	});
});

app.get("/internal/export/errors", async (c) => {
	const sourceId = c.req.query("sourceId");
	const format = (c.req.query("format") ?? "json") as ExportOptions["format"];
	const limitRaw = c.req.query("limit") ?? "10000";
	const limit = Number.parseInt(limitRaw, 10);
	const effectiveLimit = Number.isFinite(limit) ? Math.min(limit, 50000) : 10000;

	let sql = `
		SELECT
			error_id,
			source_id,
			run_id,
			phase,
			error_code,
			error_message,
			payload,
			retry_count,
			max_retries,
			status,
			resolved_at,
			created_at
		FROM ingest_errors
		WHERE 1=1
	`;
	const params: (string | number)[] = [];

	if (sourceId) {
		sql += " AND source_id = ?";
		params.push(sourceId);
	}
	sql += " ORDER BY created_at DESC LIMIT ?";
	params.push(effectiveLimit);

	const stmt = c.env.CONTROL_DB.prepare(sql).bind(...params);
	const { results } = await stmt.all();

	if (format === "csv") {
		const rows = results ?? [];
		const headers = [
			"error_id",
			"source_id",
			"run_id",
			"phase",
			"error_code",
			"error_message",
			"payload",
			"retry_count",
			"max_retries",
			"status",
			"resolved_at",
			"created_at",
		];
		const csvRows = rows.map((row) => {
			const r = row as Record<string, unknown>;
			return headers.map((h) => {
				const val = r[h];
				if (val == null) return "";
				const str = String(val);
				if (str.includes(",") || str.includes('"') || str.includes("\n")) {
					return `"${str.replace(/"/g, '""')}"`;
				}
				return str;
			}).join(",");
		});
		const csv = [headers.join(","), ...csvRows].join("\n");
		c.header("Content-Type", "text/csv");
		c.header("Content-Disposition", 'attachment; filename="uplink-errors.csv"');
		return c.body(csv);
	}

	if (format === "ndjson") {
		const lines = (results ?? [])
			.map((row) => JSON.stringify(row))
			.join("\n");
		c.header("Content-Type", "application/x-ndjson");
		c.header("Content-Disposition", 'attachment; filename="uplink-errors.ndjson"');
		return c.body(lines);
	}

	return c.json({
		meta: {
			count: results?.length ?? 0,
			format: "json",
			limit: effectiveLimit,
		},
		data: results ?? [],
	});
});

export default app;
