import { Hono } from "hono";
import type { Env } from "../types";
import {
	listActiveAlerts,
	createAlert,
	acknowledgeAlert,
	resolveAlert,
	runAllAlertChecks,
	autoResolveAlerts,
	parseAlertConfiguration,
	type AlertSeverity,
	type AlertType,
} from "../lib/alerting";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/alerts", async (c) => {
	const severity = c.req.query("severity") as AlertSeverity | undefined;
	const alertType = c.req.query("type") as AlertType | undefined;
	const sourceId = c.req.query("sourceId") ?? undefined;
	const acknowledged = c.req.query("acknowledged");
	const limitRaw = c.req.query("limit") ?? "100";
	const limit = Number.parseInt(limitRaw, 10);

	const alerts = await listActiveAlerts(c.env.CONTROL_DB, {
		severity,
		alertType,
		sourceId,
		acknowledged: acknowledged !== undefined ? acknowledged === "true" : undefined,
		limit: Number.isFinite(limit) ? limit : 100,
	});

	return c.json({ alerts, total: alerts.length });
});

app.post("/internal/alerts/check", async (c) => {
	const sourceId = c.req.query("sourceId");

	let alertConfig;
	if (sourceId) {
		const policyRow = await c.env.CONTROL_DB
			.prepare("SELECT alert_config_json FROM source_policies WHERE source_id = ?")
			.bind(sourceId)
			.first<{ alert_config_json: string | null }>();
		alertConfig = parseAlertConfiguration(policyRow?.alert_config_json ?? null);
	} else {
		alertConfig = parseAlertConfiguration(null);
	}

	const result = await runAllAlertChecks(c.env.CONTROL_DB, alertConfig);
	const resolved = await autoResolveAlerts(c.env.CONTROL_DB);

	return c.json({
		ok: true,
		checksRun: result.checksRun,
		alertsCreated: result.alertsCreated,
		alertsResolved: resolved,
		errors: result.errors,
	});
});

app.post("/internal/alerts/:alertId/acknowledge", async (c) => {
	const alertId = c.req.param("alertId");
	const success = await acknowledgeAlert(c.env.CONTROL_DB, alertId);
	if (!success) {
		return c.json({ error: "Alert not found" }, 404);
	}
	return c.json({ ok: true, alertId });
});

app.post("/internal/alerts/:alertId/resolve", async (c) => {
	const alertId = c.req.param("alertId");
	const body = await c.req.json().catch(() => ({}));
	const success = await resolveAlert(c.env.CONTROL_DB, alertId, body.note);
	if (!success) {
		return c.json({ error: "Alert not found" }, 404);
	}
	return c.json({ ok: true, alertId });
});

export default app;
