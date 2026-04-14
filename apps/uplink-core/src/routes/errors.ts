import { Hono } from "hono";
import type { Env } from "../types";
import { ErrorFilterSchema, ErrorRetryRequestSchema } from "@uplink/contracts";
import { listIngestErrors } from "../lib/db";
import { retryFailedOperation } from "../lib/processing";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/errors", async (c) => {
	const queryParams = {
		status: c.req.query("status") ?? undefined,
		sourceId: c.req.query("sourceId") ?? undefined,
		phase: c.req.query("phase") ?? undefined,
		errorCategory: c.req.query("errorCategory") ?? undefined,
		fromDate: c.req.query("fromDate") ?? undefined,
		toDate: c.req.query("toDate") ?? undefined,
		limit: c.req.query("limit") ?? "50",
		offset: c.req.query("offset") ?? "0",
	};

	const parsed = ErrorFilterSchema.safeParse({
		...queryParams,
		limit: Number.parseInt(queryParams.limit, 10),
		offset: Number.parseInt(queryParams.offset, 10),
	});

	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const result = await listIngestErrors(c.env.CONTROL_DB, parsed.data);

	return c.json({
		errors: result.errors,
		total: result.total,
		limit: parsed.data.limit,
		offset: parsed.data.offset,
		hasMore: result.total > (parsed.data.offset ?? 0) + (parsed.data.limit ?? 50),
	});
});

app.post("/internal/errors/:errorId/retry", async (c) => {
	const errorId = c.req.param("errorId");
	const body = await c.req.json().catch(() => ({}));
	const parsed = ErrorRetryRequestSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const result = await retryFailedOperation(c.env, errorId, {
		force: parsed.data.force,
		triggeredBy: parsed.data.triggeredBy,
	});

	const statusCode = result.success ? 200 : result.newStatus === "dead_letter" ? 409 : 422;

	return c.json(result, statusCode);
});

export default app;
