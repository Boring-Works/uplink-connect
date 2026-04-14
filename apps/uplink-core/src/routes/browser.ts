import { Hono } from "hono";
import type { Env } from "../types";
import { getBrowserManagerStub } from "../lib/coordinator-client";
import { testNotificationChannel } from "../lib/notifications";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/browser/status", async (c) => {
	const managerStub = getBrowserManagerStub(c.env);
	const response = await managerStub.fetch("https://browser-manager/status");

	if (!response.ok) {
		return c.json({ error: "Failed to get browser manager status" }, 502);
	}

	const status = await response.json();
	return c.json(status);
});

app.post("/internal/notifications/test/:channel", async (c) => {
	const channel = c.req.param("channel") as "webhook" | "slack";
	const body = await c.req.json().catch(() => ({}));
	const result = await testNotificationChannel(c.env, channel, body.url);
	return c.json(result, result.success ? 200 : 400);
});

export default app;
