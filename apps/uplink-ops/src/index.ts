import { Hono } from "hono";

type Env = {
	UPLINK_CORE: Fetcher;
	OPS_API_KEY?: string;
	CORE_INTERNAL_KEY?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "uplink-ops", now: new Date().toISOString() }));

app.use("/v1/*", async (c, next) => {
	if (!c.env.OPS_API_KEY) {
		return c.json({ error: "OPS_API_KEY not configured" }, 500);
	}
	const header = c.req.header("authorization");
	if (!header || !header.startsWith("Bearer ") || header.slice(7) !== c.env.OPS_API_KEY) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
});

app.get("/v1/runs", async (c) => {
	const limit = c.req.query("limit") ?? "50";
	return proxyToCore(c.env, `/internal/runs?limit=${encodeURIComponent(limit)}`);
});

app.get("/v1/runs/:runId", async (c) => {
	const runId = c.req.param("runId");
	return proxyToCore(c.env, `/internal/runs/${encodeURIComponent(runId)}`);
});

app.post("/v1/runs/:runId/replay", async (c) => {
	const runId = c.req.param("runId");
	return proxyToCore(c.env, `/internal/runs/${encodeURIComponent(runId)}/replay`, {
		method: "POST",
	});
});

app.post("/v1/sources/:sourceId/trigger", async (c) => {
	const sourceId = c.req.param("sourceId");
	const body = await c.req.json().catch(() => ({}));

	return proxyToCore(c.env, `/internal/sources/${encodeURIComponent(sourceId)}/trigger`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...body, triggeredBy: "ops" }),
	});
});

app.get("/v1/sources/:sourceId/health", async (c) => {
	const sourceId = c.req.param("sourceId");
	return proxyToCore(c.env, `/internal/sources/${encodeURIComponent(sourceId)}/health`);
});

app.get("/v1/artifacts/:artifactId", async (c) => {
	const artifactId = c.req.param("artifactId");
	return proxyToCore(c.env, `/internal/artifacts/${encodeURIComponent(artifactId)}`);
});

async function proxyToCore(env: Env, path: string, init?: RequestInit): Promise<Response> {
	const request = new Request(`https://uplink-core${path}`, {
		method: init?.method ?? "GET",
		headers: {
			"x-uplink-internal-key": env.CORE_INTERNAL_KEY ?? "",
			...(init?.headers ?? {}),
		},
		body: init?.body,
	});

	return env.UPLINK_CORE.fetch(request);
}

export default app;
