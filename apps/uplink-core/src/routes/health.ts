import { Hono } from "hono";
import type { Env } from "../types";
import { toIsoNow } from "@uplink/contracts";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
	c.json({
		ok: true,
		service: "uplink-core",
		now: toIsoNow(),
	}),
);

export default app;
