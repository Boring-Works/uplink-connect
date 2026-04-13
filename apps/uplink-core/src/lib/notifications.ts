import type { Env } from "../types";
import type { Alert, AlertConfiguration } from "./alerting";

export interface NotificationPayload {
	alert: Alert;
	sourceName?: string;
	actionUrl?: string;
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
	const errors: string[] = [];
	let sent = false;

	const payload: NotificationPayload = {
		alert,
		sourceName,
		actionUrl: `https://uplink.internal/alerts/${alert.alertId}`,
	};

	// Send to webhook if configured
	if (config.notificationChannels?.webhook) {
		try {
			await sendWebhookNotification(config.notificationChannels.webhook, payload);
			sent = true;
		} catch (error) {
			errors.push(`Webhook failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Send to Slack if SLACK_WEBHOOK_URL is configured
	if (env.SLACK_WEBHOOK_URL) {
		try {
			await sendSlackNotification(env.SLACK_WEBHOOK_URL, payload);
			sent = true;
		} catch (error) {
			errors.push(`Slack failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { sent, errors };
}

async function sendWebhookNotification(url: string, payload: NotificationPayload): Promise<void> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({
			alertId: payload.alert.alertId,
			alertType: payload.alert.alertType,
			severity: payload.alert.severity,
			message: payload.alert.message,
			recommendedAction: payload.alert.recommendedAction,
			sourceId: payload.alert.sourceId,
			sourceName: payload.sourceName,
			actionUrl: payload.actionUrl,
			timestamp: new Date().toISOString(),
		}),
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	}
}

async function sendSlackNotification(url: string, payload: NotificationPayload): Promise<void> {
	const color = payload.alert.severity === "critical" ? "#FF0000" : "#FFA500";
	const emoji = payload.alert.severity === "critical" ? ":rotating_light:" : ":warning:";

	const slackPayload = {
		text: `${emoji} Uplink Alert: ${payload.alert.severity.toUpperCase()}`,
		attachments: [
			{
				color,
				fields: [
					{
						title: "Alert Type",
						value: payload.alert.alertType,
						short: true,
					},
					{
						title: "Severity",
						value: payload.alert.severity,
						short: true,
					},
					{
						title: "Source",
						value: payload.sourceName ?? payload.alert.sourceId ?? "N/A",
						short: true,
					},
					{
						title: "Message",
						value: payload.alert.message,
						short: false,
					},
					{
						title: "Recommended Action",
						value: payload.alert.recommendedAction,
						short: false,
					},
				],
				footer: "Uplink Connect",
				ts: Math.floor(Date.now() / 1000),
			},
		],
	};

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify(slackPayload),
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	}
}

/**
 * Test notification channels
 */
export async function testNotificationChannel(
	env: Env,
	channel: "webhook" | "slack",
	testUrl?: string,
): Promise<{ success: boolean; error?: string }> {
	const testAlert: Alert = {
		alertId: "test-alert",
		alertType: "queue_lag",
		severity: "warning",
		message: "This is a test alert from Uplink Connect",
		recommendedAction: "Verify notifications are working correctly",
		createdAt: Math.floor(Date.now() / 1000),
		acknowledged: false,
	};

	const testConfig: AlertConfiguration = {
		alertRules: [],
		notificationChannels: {
			webhook: channel === "webhook" ? testUrl : undefined,
		},
	};

	if (channel === "slack" && !env.SLACK_WEBHOOK_URL) {
		return { success: false, error: "SLACK_WEBHOOK_URL not configured" };
	}

	const result = await sendNotification(env, testAlert, testConfig);

	return {
		success: result.sent,
		error: result.errors.join(", ") || undefined,
	};
}
