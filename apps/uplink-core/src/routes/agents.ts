import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/stream/dashboard", async (c) => {
	const stub = c.env.DASHBOARD_STREAM.getByName("global");
	return stub.fetch(c.req.raw);
});

app.get("/internal/agent/error", async (c) => {
	const stub = c.env.ERROR_AGENT.getByName("global");
	return stub.fetch(c.req.raw);
});

export default app;
