import { Hono } from "hono";
import type { Env } from "../types";
import {
	getComponentHealth,
	getPipelineTopology,
	getDataFlowMetrics,
	getSourceHealthTimeline,
} from "../lib/health-monitor";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/health/components", async (c) => {
	const components = await getComponentHealth(c.env);
	return c.json({ components, timestamp: new Date().toISOString() });
});

app.get("/internal/health/topology", async (c) => {
	const topology = await getPipelineTopology(c.env, c.env.CONTROL_DB);
	return c.json(topology);
});

app.get("/internal/health/flow", async (c) => {
	const windowRaw = c.req.query("window") ?? "3600";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const metrics = await getDataFlowMetrics(
		c.env.CONTROL_DB,
		Number.isFinite(windowSeconds) ? windowSeconds : 3600,
	);
	return c.json(metrics);
});

app.get("/internal/sources/:sourceId/health/timeline", async (c) => {
	const sourceId = c.req.param("sourceId");
	const windowRaw = c.req.query("window") ?? "3600";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const timeline = await getSourceHealthTimeline(
		c.env.CONTROL_DB,
		sourceId,
		Number.isFinite(windowSeconds) ? windowSeconds : 3600,
	);
	return c.json(timeline);
});

export default app;
