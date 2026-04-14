import { Hono } from "hono";
import type { Env } from "../types";
import { getArtifact } from "../lib/db";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/artifacts/:artifactId", async (c) => {
	const artifactId = c.req.param("artifactId");
	const artifact = await getArtifact(c.env.CONTROL_DB, artifactId);
	if (!artifact) {
		return c.json({ error: "Artifact not found" }, 404);
	}

	return c.json(artifact);
});

export default app;
