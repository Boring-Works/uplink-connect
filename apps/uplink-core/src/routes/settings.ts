import { Hono } from "hono";
import type { Env } from "../types";
import { getSettings, saveSettings, logAuditEvent, getAuditLog } from "../lib/settings";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/settings", async (c) => {
	const settings = await getSettings(c.env);
	return c.json(settings);
});

app.put("/internal/settings", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const actor = c.req.header("x-actor-id") ?? "system";

	const updated = await saveSettings(c.env, body, actor);

	await logAuditEvent(c.env.CONTROL_DB, {
		action: "settings.update",
		actor,
		resourceType: "settings",
		details: { changedFields: Object.keys(body) },
	});

	return c.json(updated);
});

app.get("/internal/audit-log", async (c) => {
	const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const resourceType = c.req.query("resourceType") ?? undefined;
	const actor = c.req.query("actor") ?? undefined;
	const fromDate = c.req.query("fromDate") ?? undefined;
	const toDate = c.req.query("toDate") ?? undefined;

	const result = await getAuditLog(c.env.CONTROL_DB, {
		limit: Number.isFinite(limit) ? limit : 50,
		offset: Number.isFinite(offset) ? offset : 0,
		resourceType,
		actor,
		fromDate,
		toDate,
	});

	return c.json(result);
});

export default app;
