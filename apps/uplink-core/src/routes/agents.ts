import { Hono } from "hono";
import type { Env } from "../types";
import { ensureInternalAuth } from "../lib/auth";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/stream/dashboard", async (c) => {
	const authError = ensureInternalAuth(c);
	if (authError) return authError;

	const stub = c.env.DASHBOARD_STREAM.getByName("global");
	return stub.fetch(c.req.raw);
});

app.get("/internal/agent/error", async (c) => {
	const authError = ensureInternalAuth(c);
	if (authError) return authError;

	const stub = c.env.ERROR_AGENT.getByName("global");
	return stub.fetch(c.req.raw);
});

export default app;
