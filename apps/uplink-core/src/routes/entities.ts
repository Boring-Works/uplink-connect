import { Hono } from "hono";
import type { Env } from "../types";
import { EntitySearchRequestSchema } from "@uplink/contracts";
import { querySimilarEntities, type VectorizeVectorMetadataFilter } from "../lib/vectorize";
import { getEntityLineage } from "../lib/tracing";

const app = new Hono<{ Bindings: Env }>();

app.post("/internal/search/entities", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = EntitySearchRequestSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { query, topK, filter } = parsed.data;
	if (!c.env.AI || !c.env.ENTITY_INDEX) {
		return c.json({ error: "Vector search bindings are not configured" }, 503);
	}

	const results = await querySimilarEntities(c.env, query, {
		topK: topK ?? 10,
		filter: filter as VectorizeVectorMetadataFilter | undefined,
		returnValues: false,
		returnMetadata: true,
	});

	return c.json({
		query,
		results,
		total: results.length,
	});
});

app.get("/internal/entities/:entityId/lineage", async (c) => {
	const entityId = c.req.param("entityId");
	const lineage = await getEntityLineage(c.env.CONTROL_DB, entityId);

	if (!lineage) {
		return c.json({ error: "Entity not found" }, 404);
	}

	return c.json(lineage);
});

export default app;
