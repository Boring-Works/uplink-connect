import { describe, it, expect, vi, beforeEach } from "vitest";
import * as contracts from "@uplink/contracts";
import {
	createWebhookProvider,
	createSlackProvider,
	createDiscordProvider,
	createTeamsProvider,
	createPagerDutyProvider,
	createOpsGenieProvider,
	createEmailProvider,
	createCustomProvider,
} from "../../../../lib/notifications/providers";
import { buildProviderPayload } from "../../../../lib/notifications/base";

describe("notification providers", () => {
	const createAlert = () => ({
		alertId: "alert-123",
		alertType: "queue_lag" as const,
		severity: "warning" as const,
		message: "Queue lag detected",
		recommendedAction: "Scale workers",
		createdAt: Math.floor(Date.now() / 1000),
		acknowledged: false,
	});

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("webhook provider", () => {
		it("sends POST with alert payload", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 200 }));

			const provider = createWebhookProvider("https://hooks.example.com/uplink");
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(true);
			expect(fetchSpy).toHaveBeenCalledWith("https://hooks.example.com/uplink", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: expect.stringContaining('"alertId":"alert-123"'),
				timeoutMs: 15_000,
				maxRetries: 2,
				backoffMs: 1000,
			});
		});

		it("returns error on non-200 response", async () => {
			vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("bad request", { status: 400 }));

			const provider = createWebhookProvider("https://hooks.example.com/uplink");
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(false);
			expect(result.error).toContain("400");
		});

		it("includes custom headers", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 200 }));

			const provider = createWebhookProvider("https://hooks.example.com/uplink", {
				"x-api-key": "secret123",
			});
			await provider.send(buildProviderPayload(createAlert()));

			expect(fetchSpy).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({ "x-api-key": "secret123" }),
				}),
			);
		});
	});

	describe("slack provider", () => {
		it("sends formatted slack message", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 200 }));

			const provider = createSlackProvider("https://hooks.slack.com/test");
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(true);
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.attachments[0].color).toBe("#FFA500");
		});

		it("uses red color for critical alerts", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 200 }));

			const alert = { ...createAlert(), severity: "critical" as const };
			const provider = createSlackProvider("https://hooks.slack.com/test");
			await provider.send(buildProviderPayload(alert));

			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.attachments[0].color).toBe("#FF0000");
		});
	});

	describe("discord provider", () => {
		it("sends embed message", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 200 }));

			const provider = createDiscordProvider("https://discord.com/api/webhooks/test");
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(true);
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.embeds[0].color).toBe(0xffa500);
		});
	});

	describe("teams provider", () => {
		it("sends message card", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 200 }));

			const provider = createTeamsProvider("https://outlook.office.com/webhook/test");
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(true);
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body["@type"]).toBe("MessageCard");
		});
	});

	describe("pagerduty provider", () => {
		it("sends event to PagerDuty", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 202 }));

			const provider = createPagerDutyProvider("routing-key-123");
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(true);
			expect(fetchSpy).toHaveBeenCalledWith("https://events.pagerduty.com/v2/enqueue", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: expect.stringContaining('"routing_key":"routing-key-123"'),
				timeoutMs: 15_000,
				maxRetries: 2,
				backoffMs: 1000,
			});
		});
	});

	describe("opsgenie provider", () => {
		it("sends alert to OpsGenie", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 202 }));

			const provider = createOpsGenieProvider("genie-key-123", ["team-ops"]);
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(true);
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.priority).toBe("P3");
			expect(body.responders).toEqual([{ username: "team-ops", type: "user" }]);
		});

		it("uses P1 for critical alerts", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 202 }));

			const alert = { ...createAlert(), severity: "critical" as const };
			const provider = createOpsGenieProvider("genie-key-123");
			await provider.send(buildProviderPayload(alert));

			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.priority).toBe("P1");
		});
	});

	describe("custom provider", () => {
		it("substitutes template variables", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 200 }));

			const template = '{"msg": "{{message}}", "sev": "{{severity}}"}';
			const provider = createCustomProvider(
				"https://custom.example.com/alert",
				"POST",
				{ "x-custom": "1" },
				template,
			);
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(true);
			const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
			expect(body.msg).toBe("Queue lag detected");
			expect(body.sev).toBe("warning");
		});

		it("sends GET without body", async () => {
			const fetchSpy = vi.spyOn(contracts, "fetchWithCache").mockResolvedValue(new Response("ok", { status: 200 }));

			const provider = createCustomProvider("https://custom.example.com/alert", "GET");
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(true);
			expect(fetchSpy.mock.calls[0][1].body).toBeUndefined();
		});
	});

	describe("email provider", () => {
		it("returns fallback error when email binding unavailable", async () => {
			const provider = createEmailProvider(["ops@example.com"]);
			const result = await provider.send(buildProviderPayload(createAlert()));

			expect(result.sent).toBe(false);
			expect(result.error).toContain("Cloudflare Email Workers binding not available");
		});
	});
});
