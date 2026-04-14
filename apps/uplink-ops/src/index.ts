import { Hono } from "hono";

type Env = {
	UPLINK_CORE: Fetcher;
	OPS_API_KEY?: string;
	CORE_INTERNAL_KEY?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "uplink-ops", now: new Date().toISOString() }));

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		const dummy = "\0".repeat(a.length);
		let result = 0;
		for (let i = 0; i < a.length; i++) {
			result |= a.charCodeAt(i) ^ dummy.charCodeAt(i);
		}
		return result === 0;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

app.use("/v1/*", async (c, next) => {
	if (!c.env.OPS_API_KEY) {
		return c.json({ error: "OPS_API_KEY not configured" }, 500);
	}
	const header = c.req.header("authorization");
	if (!header || !header.startsWith("Bearer ")) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const token = header.slice("Bearer ".length);
	if (!timingSafeEqual(token, c.env.OPS_API_KEY)) {
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

// ============ NEW DASHBOARD & HEALTH ENDPOINTS ============

// HTML Dashboard
app.get("/dashboard", async (c) => {
	return proxyToCore(c.env, "/dashboard");
});

// Dashboard API v2
app.get("/v1/dashboard", async (c) => {
	const window = c.req.query("window") ?? "86400";
	return proxyToCore(c.env, `/internal/dashboard/v2?window=${encodeURIComponent(window)}`);
});

// Component health
app.get("/v1/health/components", async (c) => {
	return proxyToCore(c.env, "/internal/health/components");
});

// Pipeline topology
app.get("/v1/health/topology", async (c) => {
	return proxyToCore(c.env, "/internal/health/topology");
});

// Data flow metrics
app.get("/v1/health/flow", async (c) => {
	const window = c.req.query("window") ?? "3600";
	return proxyToCore(c.env, `/internal/health/flow?window=${encodeURIComponent(window)}`);
});

// Source health timeline
app.get("/v1/sources/:sourceId/health/timeline", async (c) => {
	const sourceId = c.req.param("sourceId");
	const window = c.req.query("window") ?? "3600";
	return proxyToCore(c.env, `/internal/sources/${encodeURIComponent(sourceId)}/health/timeline?window=${encodeURIComponent(window)}`);
});

// Run trace
app.get("/v1/runs/:runId/trace", async (c) => {
	const runId = c.req.param("runId");
	return proxyToCore(c.env, `/internal/runs/${encodeURIComponent(runId)}/trace`);
});

// Entity lineage
app.get("/v1/entities/:entityId/lineage", async (c) => {
	const entityId = c.req.param("entityId");
	return proxyToCore(c.env, `/internal/entities/${encodeURIComponent(entityId)}/lineage`);
});

// Source run tree
app.get("/v1/sources/:sourceId/runs/tree", async (c) => {
	const sourceId = c.req.param("sourceId");
	const limit = c.req.query("limit") ?? "50";
	return proxyToCore(c.env, `/internal/sources/${encodeURIComponent(sourceId)}/runs/tree?limit=${encodeURIComponent(limit)}`);
});

// Settings
app.get("/v1/settings", async (c) => {
	return proxyToCore(c.env, "/internal/settings");
});

app.put("/v1/settings", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	return proxyToCore(c.env, "/internal/settings", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
});

// Audit log
app.get("/v1/audit-log", async (c) => {
	const params = new URLSearchParams();
	const limit = c.req.query("limit");
	const offset = c.req.query("offset");
	const resourceType = c.req.query("resourceType");
	const actor = c.req.query("actor");
	const fromDate = c.req.query("fromDate");
	const toDate = c.req.query("toDate");
	
	if (limit) params.set("limit", limit);
	if (offset) params.set("offset", offset);
	if (resourceType) params.set("resourceType", resourceType);
	if (actor) params.set("actor", actor);
	if (fromDate) params.set("fromDate", fromDate);
	if (toDate) params.set("toDate", toDate);
	
	const queryString = params.toString();
	return proxyToCore(c.env, `/internal/audit-log${queryString ? "?" + queryString : ""}`);
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
