import { Hono } from "hono";
import type { Env } from "../types";
import { NotificationProviderSchema, NotificationRouteSchema } from "@uplink/contracts";
import { testNotificationChannel } from "../lib/notifications";

const app = new Hono<{ Bindings: Env }>();

// List supported provider types
app.get("/internal/notifications/providers/types", (c) => {
	return c.json({
		types: [
			{ id: "webhook", name: "Webhook", description: "Generic HTTP POST webhook" },
			{ id: "slack", name: "Slack", description: "Slack incoming webhook" },
			{ id: "discord", name: "Discord", description: "Discord webhook" },
			{ id: "teams", name: "Microsoft Teams", description: "Teams connector webhook" },
			{ id: "pagerduty", name: "PagerDuty", description: "PagerDuty Events API v2" },
			{ id: "opsgenie", name: "OpsGenie", description: "Atlassian OpsGenie alerts" },
			{ id: "email", name: "Email", description: "Cloudflare Email Workers" },
			{ id: "custom", name: "Custom", description: "Custom HTTP endpoint with template" },
		],
	});
});

// Test any notification channel
app.post("/internal/notifications/test/:channel", async (c) => {
	const channel = c.req.param("channel") as Parameters<typeof testNotificationChannel>[1];
	const body = await c.req.json().catch(() => ({}));
	const result = await testNotificationChannel(c.env, channel, body.url);
	return c.json(result, result.success ? 200 : 400);
});

// Validate a provider configuration
app.post("/internal/notifications/providers/validate", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = NotificationProviderSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ valid: false, errors: parsed.error.flatten() }, 400);
	}

	return c.json({ valid: true, provider: parsed.data });
});

// Validate a route configuration
app.post("/internal/notifications/routes/validate", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = NotificationRouteSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ valid: false, errors: parsed.error.flatten() }, 400);
	}

	return c.json({ valid: true, route: parsed.data });
});

export default app;
