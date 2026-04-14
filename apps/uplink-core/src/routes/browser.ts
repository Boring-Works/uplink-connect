import { Hono } from "hono";
import type { Env } from "../types";
import { getBrowserManagerStub } from "../lib/coordinator-client";

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

export default app;
