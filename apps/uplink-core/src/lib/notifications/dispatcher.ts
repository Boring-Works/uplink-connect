import type { Alert } from "../alerting";
import type { ProviderConfig, ProviderWithId, NotificationRoute } from "./types";
import {
	createWebhookProvider,
	createSlackProvider,
	createDiscordProvider,
	createTeamsProvider,
	createPagerDutyProvider,
	createOpsGenieProvider,
	createEmailProvider,
	createCustomProvider,
} from "./providers";
import { buildProviderPayload } from "./base";

export interface DispatchResult {
	sent: number;
	failed: number;
	errors: string[];
	deliveries: Array<{ providerId: string; providerType: string; sent: boolean; error?: string }>;
}

export function buildProviderFromConfig(config: ProviderConfig, _providerId: string) {
	switch (config.type) {
		case "webhook":
			return createWebhookProvider(config.url, config.headers);
		case "slack":
			return createSlackProvider(config.webhookUrl, config.channel, config.username);
		case "discord":
			return createDiscordProvider(config.webhookUrl);
		case "teams":
			return createTeamsProvider(config.webhookUrl);
		case "pagerduty":
			return createPagerDutyProvider(config.routingKey, config.severity);
		case "opsgenie":
			return createOpsGenieProvider(config.apiKey, config.responders);
		case "email":
			return createEmailProvider(config.to, config.from, config.subjectTemplate);
		case "custom":
			return createCustomProvider(config.url, config.method, config.headers, config.bodyTemplate);
		default:
			throw new Error(`Unknown provider type: ${(config as ProviderConfig).type}`);
	}
}

export function shouldRouteToProvider(
	alert: Alert,
	route: NotificationRoute,
	sourceName?: string,
): boolean {
	if (!route.enabled) return false;
	if (route.severityFilter?.length && !route.severityFilter.includes(alert.severity)) {
		return false;
	}
	if (route.alertTypeFilter?.length && !route.alertTypeFilter.includes(alert.alertType)) {
		return false;
	}
	if (route.sourceIdFilter?.length && alert.sourceId && !route.sourceIdFilter.includes(alert.sourceId)) {
		return false;
	}
	return true;
}

export async function dispatchNotifications(
	providers: ProviderWithId[],
	routes: NotificationRoute[],
	alert: Alert,
	sourceName?: string,
): Promise<DispatchResult> {
	const result: DispatchResult = { sent: 0, failed: 0, errors: [], deliveries: [] };
	const payload = buildProviderPayload(alert, sourceName);

	for (const route of routes) {
		if (!shouldRouteToProvider(alert, route, sourceName)) {
			continue;
		}

		const providerWithId = providers.find((p) => p.providerId === route.providerId);

		if (!providerWithId) {
			result.errors.push(`Provider ${route.providerId} not found`);
			continue;
		}

		try {
			const provider = buildProviderFromConfig(providerWithId.config, route.providerId);
			const sendResult = await provider.send(payload);

			if (sendResult.sent) {
				result.sent++;
			} else {
				result.failed++;
				result.errors.push(`${providerWithId.config.type}: ${sendResult.error ?? "Unknown error"}`);
			}

			result.deliveries.push({
				providerId: route.providerId,
				providerType: providerWithId.config.type,
				sent: sendResult.sent,
				error: sendResult.error,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			result.failed++;
			result.errors.push(`${route.providerId}: ${msg}`);
			result.deliveries.push({
				providerId: route.providerId,
				providerType: providerWithId.config.type,
				sent: false,
				error: msg,
			});
		}
	}

	return result;
}
