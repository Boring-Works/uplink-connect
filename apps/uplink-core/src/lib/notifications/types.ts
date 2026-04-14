import type { Alert } from "../alerting";

export type { NotificationPayload } from "./base";

export interface ProviderWithId {
	providerId: string;
	config: ProviderConfig;
}

export type ProviderConfig =
	| { type: "webhook"; url: string; headers?: Record<string, string> }
	| { type: "slack"; webhookUrl: string; channel?: string; username?: string }
	| { type: "discord"; webhookUrl: string }
	| { type: "teams"; webhookUrl: string }
	| { type: "pagerduty"; routingKey: string; severity?: "critical" | "error" | "warning" | "info" }
	| { type: "opsgenie"; apiKey: string; responders?: string[] }
	| { type: "email"; to: string[]; from?: string; subjectTemplate?: string }
	| { type: "custom"; url: string; method: "GET" | "POST" | "PUT" | "PATCH"; headers?: Record<string, string>; bodyTemplate?: string };

export interface NotificationRoute {
	providerId: string;
	severityFilter?: string[];
	alertTypeFilter?: string[];
	sourceIdFilter?: string[];
	enabled: boolean;
}

export interface NotificationDelivery {
	deliveryId: string;
	alertId: string;
	providerType: string;
	providerId: string;
	status: "pending" | "sent" | "failed" | "retrying";
	sentAt?: string;
	errorMessage?: string;
	retryCount: number;
}
