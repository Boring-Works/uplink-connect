import type { Env } from "../types";
import type { Alert, AlertConfiguration } from "./alerting";
import type { NotificationPayload, ProviderConfig } from "./notifications/types";
import type { ProviderWithId } from "./notifications/types";
import { dispatchNotifications, buildProviderFromConfig } from "./notifications/dispatcher";
import {
	createWebhookProvider,
	createSlackProvider,
	createEmailProvider,
} from "./notifications/providers";
import { buildProviderPayload } from "./notifications/base";

export interface LegacyNotificationPayload {
	alert: Alert;
	sourceName?: string;
	actionUrl?: string;
}

function buildProvidersFromLegacyConfig(
	config: AlertConfiguration,
	env: Env,
): ProviderWithId[] {
	const providers: ProviderWithId[] = [];

	if (config.notificationChannels?.webhook) {
		providers.push({
			providerId: "legacy-webhook",
			config: { type: "webhook", url: config.notificationChannels.webhook },
		});
	}

	if (env.SLACK_WEBHOOK_URL) {
		providers.push({
			providerId: "legacy-slack",
			config: { type: "slack", webhookUrl: env.SLACK_WEBHOOK_URL },
		});
	}

	if (config.notificationChannels?.email?.length) {
		providers.push({
			providerId: "legacy-email",
			config: { type: "email", to: config.notificationChannels.email },
		});
	}

	// Also include new-style providers
	for (const [index, provider] of (config.providers ?? []).entries()) {
		providers.push({
			providerId: provider.providerId ?? `provider-${index}`,
			config: provider as unknown as ProviderConfig,
		});
	}

	return providers;
}

function buildRoutesFromLegacyConfig(config: AlertConfiguration) {
	const routes = config.routes ?? [];

	// Add legacy routes for backward compatibility
	if (config.notificationChannels?.webhook) {
		routes.push({
			providerId: "legacy-webhook",
			enabled: true,
		});
	}

	if (config.notificationChannels?.email?.length) {
		routes.push({
			providerId: "legacy-email",
			enabled: true,
		});
	}

	return routes;
}

/**
 * Send notification to configured channels
 */
export async function sendNotification(
	env: Env,
	alert: Alert,
	config: AlertConfiguration,
	sourceName?: string,
): Promise<{ sent: boolean; errors: string[] }> {
	const providers = buildProvidersFromLegacyConfig(config, env);
	const routes = buildRoutesFromLegacyConfig(config);

	if (providers.length === 0 || routes.length === 0) {
		return { sent: false, errors: [] };
	}

	try {
		const id = env.NOTIFICATION_DISPATCHER.idFromName("global");
		const dispatcher = env.NOTIFICATION_DISPATCHER.get(id);
		const result = await dispatcher.dispatch(alert, providers, routes, sourceName);

		return {
			sent: result.sent > 0,
			errors: result.errors,
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { sent: false, errors: [`Dispatcher failed: ${msg}`] };
	}
}

/**
 * Test notification channels
 */
function isAllowedTestUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		const hostname = parsed.hostname.toLowerCase();
		// Block localhost and private IPs
		if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
		if (/^10\./.test(hostname)) return false;
		if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return false;
		if (/^192\.168\./.test(hostname)) return false;
		if (/^169\.254\./.test(hostname)) return false;
		if (/^0\./.test(hostname)) return false;
		if (/^fc00:/i.test(hostname)) return false;
		if (/^fe80:/i.test(hostname)) return false;
		return true;
	} catch {
		return false;
	}
}

export async function testNotificationChannel(
	env: Env,
	channel: "webhook" | "slack" | "discord" | "teams" | "pagerduty" | "opsgenie" | "email" | "custom",
	testUrl?: string,
): Promise<{ success: boolean; error?: string }> {
	if (testUrl && !isAllowedTestUrl(testUrl)) {
		return { success: false, error: "Invalid or disallowed URL for test" };
	}

	const testAlert: Alert = {
		alertId: "test-alert",
		alertType: "queue_lag",
		severity: "warning",
		message: "This is a test alert from Uplink Connect",
		recommendedAction: "Verify notifications are working correctly",
		createdAt: Math.floor(Date.now() / 1000),
		acknowledged: false,
	};

	let providerConfig: ProviderConfig;

	switch (channel) {
		case "webhook":
			if (!testUrl) return { success: false, error: "URL required for webhook test" };
			providerConfig = { type: "webhook", url: testUrl };
			break;
		case "slack":
			if (!testUrl && !env.SLACK_WEBHOOK_URL) {
				return { success: false, error: "SLACK_WEBHOOK_URL not configured" };
			}
			providerConfig = { type: "slack", webhookUrl: testUrl ?? env.SLACK_WEBHOOK_URL! };
			break;
		case "discord":
			if (!testUrl) return { success: false, error: "URL required for Discord test" };
			providerConfig = { type: "discord", webhookUrl: testUrl };
			break;
		case "teams":
			if (!testUrl) return { success: false, error: "URL required for Teams test" };
			providerConfig = { type: "teams", webhookUrl: testUrl };
			break;
		case "pagerduty":
			if (!testUrl) return { success: false, error: "Routing key required for PagerDuty test" };
			providerConfig = { type: "pagerduty", routingKey: testUrl };
			break;
		case "opsgenie":
			if (!testUrl) return { success: false, error: "API key required for OpsGenie test" };
			providerConfig = { type: "opsgenie", apiKey: testUrl };
			break;
		case "email":
			if (!testUrl) return { success: false, error: "Email address required for email test" };
			providerConfig = { type: "email", to: [testUrl] };
			break;
		case "custom":
			if (!testUrl) return { success: false, error: "URL required for custom test" };
			providerConfig = { type: "custom", url: testUrl, method: "POST" };
			break;
		default:
			return { success: false, error: `Unknown channel: ${channel}` };
	}

	try {
		const provider = buildProviderFromConfigForTest(providerConfig);
		const payload = buildProviderPayload(testAlert);
		const result = await provider.send(payload);
		return {
			success: result.sent,
			error: result.error,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function buildProviderFromConfigForTest(config: ProviderConfig) {
	switch (config.type) {
		case "webhook":
			return createWebhookProvider(config.url, config.headers);
		case "slack":
			return createSlackProvider(config.webhookUrl, config.channel, config.username);
		case "email":
			return createEmailProvider(config.to, config.from, config.subjectTemplate);
		default:
			return buildProviderFromConfig(config, "test");
	}
}
