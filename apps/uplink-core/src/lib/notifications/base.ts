import type { Alert } from "../alerting";

export interface NotificationPayload {
	alert: Alert;
	sourceName?: string;
	actionUrl?: string;
}

export interface SendResult {
	sent: boolean;
	error?: string;
	providerResponse?: unknown;
}

export interface NotificationProvider {
	name: string;
	send(payload: NotificationPayload): Promise<SendResult>;
}

export function buildProviderPayload(alert: Alert, sourceName?: string): NotificationPayload {
	return {
		alert,
		sourceName,
		actionUrl: `https://uplink-core.codyboring.workers.dev/internal/alerts/${alert.alertId}`,
	};
}

export function formatAlertTitle(payload: NotificationPayload): string {
	const severity = payload.alert.severity.toUpperCase();
	const type = payload.alert.alertType;
	const source = payload.sourceName ?? payload.alert.sourceId ?? "system";
	return `[${severity}] ${type} - ${source}`;
}

export function formatAlertBody(payload: NotificationPayload): string {
	const lines = [
		`Alert: ${payload.alert.alertType}`,
		`Severity: ${payload.alert.severity}`,
		`Message: ${payload.alert.message}`,
		`Recommended Action: ${payload.alert.recommendedAction}`,
	];
	if (payload.alert.sourceId) lines.push(`Source: ${payload.sourceName ?? payload.alert.sourceId}`);
	if (payload.alert.runId) lines.push(`Run: ${payload.alert.runId}`);
	if (payload.actionUrl) lines.push(`View: ${payload.actionUrl}`);
	return lines.join("\n");
}
