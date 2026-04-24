import { Hono } from "hono";
import type { Env } from "../types";
import { getBrowserManagerStub, getBrowserManagerStatus } from "../lib/coordinator-client";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/browser/status", async (c) => {
	const managerStub = getBrowserManagerStub(c.env);
	const status = await getBrowserManagerStatus(managerStub);
	return c.json(status);
});

export default app;
