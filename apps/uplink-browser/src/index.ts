import { Hono } from "hono";
import { z } from "zod";

type Env = {
	BROWSER_API_KEY?: string;
	BROWSER?: unknown;
};

const CollectRequestSchema = z.object({
	sourceId: z.string().min(1),
	url: z.string().url(),
	headers: z.record(z.string(), z.string()).optional(),
	cursor: z.string().optional(),
});

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "uplink-browser", now: new Date().toISOString() }));

app.post("/internal/collect", async (c) => {
	if (!c.env.BROWSER_API_KEY) {
		return c.json({ error: "BROWSER_API_KEY not configured" }, 500);
	}

	if (!isAuthorized(c.req.raw, c.env.BROWSER_API_KEY)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json().catch(() => null);
	const parsed = CollectRequestSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { sourceId, url, headers } = parsed.data;

	const response = await fetch(url, {
		method: "GET",
		headers: {
			"user-agent":
				"Mozilla/5.0 (compatible; UplinkConnect/3.01; +https://uplink.internal)",
			accept: "text/html,application/json;q=0.9,*/*;q=0.8",
			...headers,
		},
	});

	const rawText = await response.text();
	const limitedText = rawText.length > 250000 ? rawText.slice(0, 250000) : rawText;

	return c.json({
		records: [
			{
				sourceId,
				url,
				status: response.status,
				contentType: response.headers.get("content-type"),
				body: limitedText,
				fetchedAt: new Date().toISOString(),
			},
		],
		hasMore: false,
	});
});

function isAuthorized(request: Request, apiKey: string): boolean {
	const authHeader = request.headers.get("authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return false;
	}
	return authHeader.slice("Bearer ".length) === apiKey;
}

export default app;
