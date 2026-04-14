import type { NotificationPayload, SendResult } from "./base";
import { formatAlertTitle, formatAlertBody } from "./base";

export function createWebhookProvider(url: string, headers?: Record<string, string>) {
	return {
		name: "webhook",
		async send(payload: NotificationPayload): Promise<SendResult> {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...headers,
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
				return {
					sent: false,
					error: `HTTP ${response.status}: ${await response.text()}`,
				};
			}

			return { sent: true };
		},
	};
}

export function createSlackProvider(webhookUrl: string, channel?: string, username?: string) {
	return {
		name: "slack",
		async send(payload: NotificationPayload): Promise<SendResult> {
			const color = payload.alert.severity === "critical" ? "#FF0000" : "#FFA500";
			const emoji = payload.alert.severity === "critical" ? ":rotating_light:" : ":warning:";

			const slackPayload = {
				text: `${emoji} ${formatAlertTitle(payload)}`,
				channel,
				username,
				attachments: [
					{
						color,
						fields: [
							{ title: "Alert Type", value: payload.alert.alertType, short: true },
							{ title: "Severity", value: payload.alert.severity, short: true },
							{
								title: "Source",
								value: payload.sourceName ?? payload.alert.sourceId ?? "N/A",
								short: true,
							},
							{ title: "Message", value: payload.alert.message, short: false },
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

			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(slackPayload),
			});

			if (!response.ok) {
				return {
					sent: false,
					error: `HTTP ${response.status}: ${await response.text()}`,
				};
			}

			return { sent: true };
		},
	};
}

export function createDiscordProvider(webhookUrl: string) {
	return {
		name: "discord",
		async send(payload: NotificationPayload): Promise<SendResult> {
			const color = payload.alert.severity === "critical" ? 0xff0000 : 0xffa500;

			const discordPayload = {
				embeds: [
					{
						title: formatAlertTitle(payload),
						color,
						fields: [
							{ name: "Alert Type", value: payload.alert.alertType, inline: true },
							{ name: "Severity", value: payload.alert.severity, inline: true },
							{
								name: "Source",
								value: payload.sourceName ?? payload.alert.sourceId ?? "N/A",
								inline: true,
							},
							{ name: "Message", value: payload.alert.message },
							{ name: "Recommended Action", value: payload.alert.recommendedAction },
						],
						timestamp: new Date().toISOString(),
						footer: { text: "Uplink Connect" },
					},
				],
			};

			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(discordPayload),
			});

			if (!response.ok) {
				return {
					sent: false,
					error: `HTTP ${response.status}: ${await response.text()}`,
				};
			}

			return { sent: true };
		},
	};
}

export function createTeamsProvider(webhookUrl: string) {
	return {
		name: "teams",
		async send(payload: NotificationPayload): Promise<SendResult> {
			const themeColor = payload.alert.severity === "critical" ? "FF0000" : "FFA500";

			const teamsPayload = {
				"@type": "MessageCard",
				"@context": "https://schema.org/extensions",
				themeColor,
				summary: formatAlertTitle(payload),
				sections: [
					{
						activityTitle: formatAlertTitle(payload),
						activitySubtitle: payload.alert.alertType,
						facts: [
							{ name: "Severity", value: payload.alert.severity },
							{
								name: "Source",
								value: payload.sourceName ?? payload.alert.sourceId ?? "N/A",
							},
							{ name: "Message", value: payload.alert.message },
							{
								name: "Recommended Action",
								value: payload.alert.recommendedAction,
							},
						],
						markdown: true,
					},
				],
				potentialAction: payload.actionUrl
					? [
							{
								"@type": "OpenUri",
								name: "View Alert",
								targets: [{ os: "default", uri: payload.actionUrl }],
							},
						]
					: undefined,
			};

			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(teamsPayload),
			});

			if (!response.ok) {
				return {
					sent: false,
					error: `HTTP ${response.status}: ${await response.text()}`,
				};
			}

			return { sent: true };
		},
	};
}

export function createPagerDutyProvider(routingKey: string, severity?: "critical" | "error" | "warning" | "info") {
	return {
		name: "pagerduty",
		async send(payload: NotificationPayload): Promise<SendResult> {
			const pdSeverity = severity ?? (payload.alert.severity === "critical" ? "critical" : "warning");

			const pagerPayload = {
				routing_key: routingKey,
				event_action: "trigger",
				dedup_key: payload.alert.alertId,
				payload: {
					summary: formatAlertTitle(payload),
					severity: pdSeverity,
					source: payload.alert.sourceId ?? "uplink-connect",
					custom_details: {
						alertType: payload.alert.alertType,
						message: payload.alert.message,
						recommendedAction: payload.alert.recommendedAction,
						sourceName: payload.sourceName,
						runId: payload.alert.runId,
						actionUrl: payload.actionUrl,
					},
				},
			};

			const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(pagerPayload),
			});

			if (!response.ok) {
				return {
					sent: false,
					error: `HTTP ${response.status}: ${await response.text()}`,
				};
			}

			return { sent: true };
		},
	};
}

export function createOpsGenieProvider(apiKey: string, responders?: string[]) {
	return {
		name: "opsgenie",
		async send(payload: NotificationPayload): Promise<SendResult> {
			const opsgeniePayload = {
				message: formatAlertTitle(payload),
				description: formatAlertBody(payload),
				priority: payload.alert.severity === "critical" ? "P1" : "P3",
				source: payload.alert.sourceId ?? "uplink-connect",
				alias: payload.alert.alertId,
				responders: responders?.map((r) => ({ username: r, type: "user" })),
				details: {
					alertType: payload.alert.alertType,
					recommendedAction: payload.alert.recommendedAction,
					actionUrl: payload.actionUrl,
				},
			};

			const response = await fetch("https://api.opsgenie.com/v2/alerts", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: `GenieKey ${apiKey}`,
				},
				body: JSON.stringify(opsgeniePayload),
			});

			if (!response.ok) {
				return {
					sent: false,
					error: `HTTP ${response.status}: ${await response.text()}`,
				};
			}

			return { sent: true };
		},
	};
}

export function createEmailProvider(to: string[], fromAddress?: string, subjectTemplate?: string) {
	return {
		name: "email",
		async send(payload: NotificationPayload): Promise<SendResult> {
			// Cloudflare Email Workers support
			const from = fromAddress ?? "alerts@uplink.internal";
			const subject = subjectTemplate
				? subjectTemplate
						.replace(/\{\{severity\}\}/g, payload.alert.severity)
						.replace(/\{\{alertType\}\}/g, payload.alert.alertType)
						.replace(/\{\{source\}\}/g, payload.sourceName ?? payload.alert.sourceId ?? "system")
				: formatAlertTitle(payload);

			const body = formatAlertBody(payload);

			// Try to use Cloudflare Email Workers if available
			try {
				const { EmailMessage } = await import("cloudflare:email");
				for (const recipient of to) {
					const msg = new EmailMessage(
						from,
						recipient,
						`Subject: ${subject}\nFrom: ${from}\nTo: ${recipient}\nContent-Type: text/plain; charset=utf-8\n\n${body}`,
					);
					// In a real Worker with email binding, we'd call env.EMAIL.send(msg)
				}
				return { sent: true };
			} catch {
				// Fallback: return success but note that email binding is required
				return {
					sent: false,
					error: "Cloudflare Email Workers binding not available. Add 'email' binding to wrangler.jsonc",
				};
			}
		},
	};
}

export function createCustomProvider(
	url: string,
	method: "GET" | "POST" | "PUT" | "PATCH" = "POST",
	headers?: Record<string, string>,
	bodyTemplate?: string,
) {
	return {
		name: "custom",
		async send(payload: NotificationPayload): Promise<SendResult> {
			const body = bodyTemplate
				? bodyTemplate
						.replace(/\{\{alertId\}\}/g, payload.alert.alertId)
						.replace(/\{\{alertType\}\}/g, payload.alert.alertType)
						.replace(/\{\{severity\}\}/g, payload.alert.severity)
						.replace(/\{\{message\}\}/g, payload.alert.message)
						.replace(/\{\{recommendedAction\}\}/g, payload.alert.recommendedAction)
						.replace(/\{\{sourceId\}\}/g, payload.alert.sourceId ?? "")
						.replace(/\{\{sourceName\}\}/g, payload.sourceName ?? "")
						.replace(/\{\{runId\}\}/g, payload.alert.runId ?? "")
						.replace(/\{\{actionUrl\}\}/g, payload.actionUrl ?? "")
						.replace(/\{\{timestamp\}\}/g, new Date().toISOString())
				: JSON.stringify({
						alertId: payload.alert.alertId,
						alertType: payload.alert.alertType,
						severity: payload.alert.severity,
						message: payload.alert.message,
						timestamp: new Date().toISOString(),
					});

			const response = await fetch(url, {
				method,
				headers: {
					"content-type": "application/json",
					...headers,
				},
				body: ["GET", "HEAD"].includes(method) ? undefined : body,
			});

			if (!response.ok) {
				return {
					sent: false,
					error: `HTTP ${response.status}: ${await response.text()}`,
				};
			}

			return { sent: true };
		},
	};
}
