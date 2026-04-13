import type { Env } from "../types";

export interface PlatformSettings {
	// Global ingestion settings
	defaultSourcePolicy: {
		minIntervalSeconds: number;
		leaseTtlSeconds: number;
		maxRecordsPerRun: number;
		retryLimit: number;
		timeoutSeconds: number;
	};

	// Alerting defaults
	alertDefaults: {
		sourceFailureRateWarning: number;
		sourceFailureRateCritical: number;
		queueLagWarningSeconds: number;
		queueLagCriticalSeconds: number;
		stuckRunWarningSeconds: number;
		stuckRunCriticalSeconds: number;
	};

	// Retention policies
	retention: {
		runHistoryDays: number;
		rawArtifactDays: number;
		errorHistoryDays: number;
		alertHistoryDays: number;
		metricAggregationDays: number;
	};

	// Platform behavior
	platform: {
		maintenanceMode: boolean;
		maintenanceMessage?: string;
		autoPauseFailedSources: boolean;
		maxConsecutiveFailures: number;
		defaultWebhookSignatureHeader: string;
	};

	// Notification defaults
	notifications: {
		slackWebhookUrl?: string;
		defaultNotificationChannels: string[];
	};

	// Feature flags
	features: {
		enablePipelines: boolean;
		enableVectorize: boolean;
		enableBrowserRendering: boolean;
		enableAiExtraction: boolean;
	};

	// Metadata
	updatedAt: string;
	updatedBy?: string;
}

const DEFAULT_SETTINGS: PlatformSettings = {
	defaultSourcePolicy: {
		minIntervalSeconds: 60,
		leaseTtlSeconds: 300,
		maxRecordsPerRun: 1000,
		retryLimit: 3,
		timeoutSeconds: 60,
	},
	alertDefaults: {
		sourceFailureRateWarning: 0.1,
		sourceFailureRateCritical: 0.3,
		queueLagWarningSeconds: 60,
		queueLagCriticalSeconds: 300,
		stuckRunWarningSeconds: 600,
		stuckRunCriticalSeconds: 1800,
	},
	retention: {
		runHistoryDays: 90,
		rawArtifactDays: 365,
		errorHistoryDays: 90,
		alertHistoryDays: 365,
		metricAggregationDays: 90,
	},
	platform: {
		maintenanceMode: false,
		autoPauseFailedSources: true,
		maxConsecutiveFailures: 5,
		defaultWebhookSignatureHeader: "x-webhook-signature",
	},
	notifications: {
		defaultNotificationChannels: [],
	},
	features: {
		enablePipelines: false,
		enableVectorize: true,
		enableBrowserRendering: true,
		enableAiExtraction: false,
	},
	updatedAt: new Date().toISOString(),
};

const SETTINGS_KEY = "platform_settings_v1";

/**
 * Get platform settings, creating defaults if none exist
 */
export async function getSettings(env: Env): Promise<PlatformSettings> {
	try {
		const stored = await env.CONTROL_DB.prepare(
			`SELECT settings_json FROM platform_settings WHERE settings_key = ?`,
		)
			.bind(SETTINGS_KEY)
			.first<{ settings_json: string }>();

		if (stored?.settings_json) {
			const parsed = JSON.parse(stored.settings_json);
			return mergeWithDefaults(parsed);
		}
	} catch (error) {
		console.error("Failed to load settings:", error);
	}

	return { ...DEFAULT_SETTINGS };
}

/**
 * Save platform settings
 */
export async function saveSettings(
	env: Env,
	settings: Partial<PlatformSettings>,
	updatedBy?: string,
): Promise<PlatformSettings> {
	const current = await getSettings(env);
	const merged = mergeWithDefaults({
		...current,
		...settings,
		updatedAt: new Date().toISOString(),
		updatedBy,
	});

	await env.CONTROL_DB.prepare(
		`INSERT INTO platform_settings (settings_key, settings_json, updated_at, updated_by)
		VALUES (?, ?, unixepoch(), ?)
		ON CONFLICT(settings_key) DO UPDATE SET
			settings_json = excluded.settings_json,
			updated_at = excluded.updated_at,
			updated_by = excluded.updated_by`,
	)
		.bind(SETTINGS_KEY, JSON.stringify(merged), updatedBy ?? null)
		.run();

	return merged;
}

/**
 * Log an audit event
 */
export async function logAuditEvent(
	db: D1Database,
	event: {
		action: string;
		actor?: string;
		resourceType: string;
		resourceId?: string;
		details?: Record<string, unknown>;
	},
): Promise<void> {
	await db.prepare(
		`INSERT INTO audit_log (
			audit_id, action, actor, resource_type, resource_id, details_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
	)
		.bind(
			crypto.randomUUID(),
			event.action,
			event.actor ?? null,
			event.resourceType,
			event.resourceId ?? null,
			event.details ? JSON.stringify(event.details) : null,
		)
		.run();
}

/**
 * Get audit log entries
 */
export async function getAuditLog(
	db: D1Database,
	params: {
		limit?: number;
		offset?: number;
		resourceType?: string;
		actor?: string;
		fromDate?: string;
		toDate?: string;
	},
): Promise<{
	items: Array<{
		auditId: string;
		action: string;
		actor?: string;
		resourceType: string;
		resourceId?: string;
		details?: Record<string, unknown>;
		createdAt: number;
	}>;
	total: number;
}> {
	const limit = Math.max(1, Math.min(params.limit ?? 50, 500));
	const offset = Math.max(0, params.offset ?? 0);

	const conditions: string[] = [];
	const bindParams: (string | number)[] = [];

	if (params.resourceType) {
		conditions.push("resource_type = ?");
		bindParams.push(params.resourceType);
	}
	if (params.actor) {
		conditions.push("actor = ?");
		bindParams.push(params.actor);
	}
	if (params.fromDate) {
		conditions.push("created_at >= unixepoch(?)");
		bindParams.push(params.fromDate);
	}
	if (params.toDate) {
		conditions.push("created_at <= unixepoch(?)");
		bindParams.push(params.toDate);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const countResult = await db
		.prepare(`SELECT COUNT(*) as total FROM audit_log ${whereClause}`)
		.bind(...bindParams)
		.first<{ total: number }>();

	const queryParams = [...bindParams, limit, offset];
	const result = await db
		.prepare(
			`SELECT 
				audit_id, action, actor, resource_type, resource_id, 
				details_json, created_at
			FROM audit_log
			${whereClause}
			ORDER BY created_at DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(...queryParams)
		.all<{
			audit_id: string;
			action: string;
			actor: string | null;
			resource_type: string;
			resource_id: string | null;
			details_json: string | null;
			created_at: number;
		}>();

	return {
		items: (result.results ?? []).map((row) => ({
			auditId: row.audit_id,
			action: row.action,
			actor: row.actor ?? undefined,
			resourceType: row.resource_type,
			resourceId: row.resource_id ?? undefined,
			details: row.details_json ? JSON.parse(row.details_json) : undefined,
			createdAt: row.created_at,
		})),
		total: countResult?.total ?? 0,
	};
}

function mergeWithDefaults(partial: Partial<PlatformSettings>): PlatformSettings {
	return {
		defaultSourcePolicy: {
			...DEFAULT_SETTINGS.defaultSourcePolicy,
			...partial.defaultSourcePolicy,
		},
		alertDefaults: {
			...DEFAULT_SETTINGS.alertDefaults,
			...partial.alertDefaults,
		},
		retention: {
			...DEFAULT_SETTINGS.retention,
			...partial.retention,
		},
		platform: {
			...DEFAULT_SETTINGS.platform,
			...partial.platform,
		},
		notifications: {
			...DEFAULT_SETTINGS.notifications,
			...partial.notifications,
		},
		features: {
			...DEFAULT_SETTINGS.features,
			...partial.features,
		},
		updatedAt: partial.updatedAt ?? DEFAULT_SETTINGS.updatedAt,
		updatedBy: partial.updatedBy,
	};
}
