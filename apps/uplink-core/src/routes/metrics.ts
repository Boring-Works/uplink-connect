import { Hono } from "hono";
import type { Env } from "../types";
import {
	getPerSourceMetrics,
	getAllSourceMetrics,
	getQueueMetrics,
	getEntityMetrics,
	getSystemMetrics,
} from "../lib/metrics";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/metrics/system", async (c) => {
	const metrics = await getSystemMetrics(c.env.CONTROL_DB);
	return c.json(metrics);
});

app.get("/internal/metrics/sources", async (c) => {
	const windowRaw = c.req.query("window") ?? "3600";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const metrics = await getAllSourceMetrics(
		c.env.CONTROL_DB,
		Number.isFinite(windowSeconds) ? windowSeconds : 3600,
	);
	return c.json({ sources: metrics, total: metrics.length });
});

app.get("/internal/metrics/sources/:sourceId", async (c) => {
	const sourceId = c.req.param("sourceId");
	const windowRaw = c.req.query("window") ?? "3600";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const metrics = await getPerSourceMetrics(
		c.env.CONTROL_DB,
		sourceId,
		Number.isFinite(windowSeconds) ? windowSeconds : 3600,
	);
	if (!metrics) {
		return c.json({ error: "Source not found or no data" }, 404);
	}
	return c.json(metrics);
});

app.get("/internal/metrics/queue", async (c) => {
	const metrics = await getQueueMetrics(c.env.CONTROL_DB);
	return c.json(metrics);
});

app.get("/internal/metrics/entities", async (c) => {
	const metrics = await getEntityMetrics(c.env.CONTROL_DB);
	return c.json(metrics);
});

export default app;
