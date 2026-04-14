import { Hono } from "hono";
import type { Env } from "../types";
import { toIsoNow } from "@uplink/contracts";
import { getComponentHealth } from "../lib/health-monitor";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
	const components = await getComponentHealth(c.env);
	const unhealthy = components.filter((c) => c.status === "unhealthy").length;
	const degraded = components.filter((c) => c.status === "degraded").length;
	const overall = unhealthy > 0 ? "unhealthy" : degraded > 0 ? "degraded" : "healthy";

	return c.json({
		ok: overall === "healthy",
		service: "uplink-core",
		status: overall,
		components: components.map((c) => ({ id: c.id, status: c.status, latencyMs: c.latencyMs })),
		aiDefined: typeof c.env.AI !== "undefined" && c.env.AI !== null,
		now: toIsoNow(),
	});
});

export default app;
