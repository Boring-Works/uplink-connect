import type { Env } from "../types";
import type { ProviderWithId, NotificationRoute } from "./notifications/types";

export type AlertSeverity = "warning" | "critical";

export type AlertType =
	| "source_failure_rate"
	| "queue_lag"
	| "run_stuck"
	| "lease_expired";

export interface AlertRule {
	alertType: AlertType;
	severity: AlertSeverity;
	threshold: number;
	windowSeconds: number;
	enabled: boolean;
}

export interface Alert {
	alertId: string;
	alertType: AlertType;
	severity: AlertSeverity;
	sourceId?: string;
	runId?: string;
	message: string;
	recommendedAction: string;
	createdAt: number;
	acknowledged: boolean;
}

export interface AlertConfiguration {
	alertRules: AlertRule[];
	providers?: ProviderWithId[];
	routes?: NotificationRoute[];
	notificationChannels?: {
		webhook?: string;
		email?: string[];
	};
}

const DEFAULT_ALERT_RULES: AlertRule[] = [
	{
		alertType: "source_failure_rate",
		severity: "warning",
		threshold: 0.1, // 10% failure rate
		windowSeconds: 300, // 5 minutes
		enabled: true,
	},
	{
		alertType: "source_failure_rate",
		severity: "critical",
		threshold: 0.3, // 30% failure rate
		windowSeconds: 300,
		enabled: true,
	},
	{
		alertType: "queue_lag",
		severity: "warning",
		threshold: 60, // 60 seconds
		windowSeconds: 60,
		enabled: true,
	},
	{
		alertType: "queue_lag",
		severity: "critical",
		threshold: 300, // 5 minutes
		windowSeconds: 60,
		enabled: true,
	},
	{
		alertType: "run_stuck",
		severity: "warning",
		threshold: 600, // 10 minutes
		windowSeconds: 60,
		enabled: true,
	},
	{
		alertType: "run_stuck",
		severity: "critical",
		threshold: 1800, // 30 minutes
		windowSeconds: 60,
		enabled: true,
	},
	{
		alertType: "lease_expired",
		severity: "critical",
		threshold: 1, // Any expired lease
		windowSeconds: 0,
		enabled: true,
	},
];

export function getDefaultAlertRules(): AlertRule[] {
	return DEFAULT_ALERT_RULES.map((r) => ({ ...r }));
}

export function parseAlertConfiguration(json: string | null): AlertConfiguration {
	if (!json) {
		return { alertRules: getDefaultAlertRules() };
	}
	try {
		const parsed = JSON.parse(json);
		return {
			alertRules: parsed.alertRules?.length
				? parsed.alertRules
				: getDefaultAlertRules(),
			notificationChannels: parsed.notificationChannels,
		};
	} catch {
		return { alertRules: getDefaultAlertRules() };
	}
}

export function serializeAlertConfiguration(config: AlertConfiguration): string {
	return JSON.stringify(config);
}

// Deduplication key for alerts
function getAlertKey(
	alertType: AlertType,
	severity: AlertSeverity,
	sourceId?: string,
	runId?: string,
): string {
	const parts: string[] = [alertType, severity];
	if (sourceId) parts.push(sourceId);
	if (runId) parts.push(runId);
	return parts.join(":");
}

export async function listActiveAlerts(
	db: D1Database,
	filters?: {
		severity?: AlertSeverity;
		alertType?: AlertType;
		sourceId?: string;
		acknowledged?: boolean;
		limit?: number;
	},
): Promise<Alert[]> {
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (filters?.severity) {
		conditions.push("severity = ?");
		params.push(filters.severity);
	}
	if (filters?.alertType) {
		conditions.push("alert_type = ?");
		params.push(filters.alertType);
	}
	if (filters?.sourceId) {
		conditions.push("source_id = ?");
		params.push(filters.sourceId);
	}
	if (filters?.acknowledged !== undefined) {
		conditions.push("acknowledged = ?");
		params.push(filters.acknowledged ? 1 : 0);
	}

	const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	const limitClause = filters?.limit ? "LIMIT ?" : "";
	if (filters?.limit) {
		params.push(filters.limit);
	}

	const result = await db
		.prepare(
			`SELECT
				alert_id, alert_type, severity, source_id, run_id,
				message, recommended_action, created_at, acknowledged
			FROM alerts_active
			${whereClause}
			ORDER BY
				CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
				created_at DESC
			${limitClause}`,
		)
		.bind(...params)
		.all<{
			alert_id: string;
			alert_type: AlertType;
			severity: AlertSeverity;
			source_id: string | null;
			run_id: string | null;
			message: string;
			recommended_action: string;
			created_at: number;
			acknowledged: number;
		}>();

	return (result.results ?? []).map((row) => ({
		alertId: row.alert_id,
		alertType: row.alert_type,
		severity: row.severity,
		sourceId: row.source_id ?? undefined,
		runId: row.run_id ?? undefined,
		message: row.message,
		recommendedAction: row.recommended_action,
		createdAt: row.created_at,
		acknowledged: Boolean(row.acknowledged),
	}));
}

export async function createAlert(
	db: D1Database,
	alert: Omit<Alert, "alertId" | "createdAt">,
	env?: Env,
	alertConfig?: AlertConfiguration,
	sourceName?: string,
): Promise<{ created: boolean; alertId?: string; notifications?: { sent: number; failed: number; throttled: number; errors: string[] } }> {
	const alertId = crypto.randomUUID();
	const dedupKey = getAlertKey(
		alert.alertType,
		alert.severity,
		alert.sourceId,
		alert.runId,
	);
	const now = Math.floor(Date.now() / 1000);

	// Use INSERT OR IGNORE with unique constraint on dedup_key for deduplication
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO alerts_active (
				alert_id, dedup_key, alert_type, severity, source_id, run_id,
				message, recommended_action, created_at, acknowledged
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			alertId,
			dedupKey,
			alert.alertType,
			alert.severity,
			alert.sourceId ?? null,
			alert.runId ?? null,
			alert.message,
			alert.recommendedAction,
			now,
			alert.acknowledged ? 1 : 0,
		)
		.run();

	// Check if row was actually inserted
	if (!result.success || result.meta?.changes === 0) {
		return { created: false };
	}

	// Dispatch notifications if env and config provided
	let notifications: { sent: number; failed: number; throttled: number; errors: string[] } | undefined;
	if (env && alertConfig?.providers?.length && alertConfig?.routes?.length) {
		const fullAlert: Alert = { ...alert, alertId, createdAt: now, acknowledged: alert.acknowledged ?? false };
		notifications = await dispatchAlertNotifications(env, fullAlert, alertConfig, sourceName);
	}

	return { created: true, alertId, notifications };
}

async function dispatchAlertNotifications(
	env: Env,
	alert: Alert,
	alertConfig: AlertConfiguration,
	sourceName?: string,
): Promise<{ sent: number; failed: number; throttled: number; errors: string[] }> {
	try {
		const { dispatchNotifications } = await import("./notifications/dispatcher");
		const result = await dispatchNotifications(
			alertConfig.providers ?? [],
			alertConfig.routes ?? [],
			alert,
			sourceName,
		);
		return {
			sent: result.sent,
			failed: result.failed,
			throttled: 0,
			errors: result.errors,
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { sent: 0, failed: 0, throttled: 0, errors: [`Dispatcher failed: ${msg}`] };
	}
}

export async function acknowledgeAlert(
	db: D1Database,
	alertId: string,
): Promise<boolean> {
	const result = await db
		.prepare("UPDATE alerts_active SET acknowledged = 1 WHERE alert_id = ?")
		.bind(alertId)
		.run();
	return result.success && (result.meta?.changes ?? 0) > 0;
}

export async function resolveAlert(
	db: D1Database,
	alertId: string,
	resolutionNote?: string,
): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);

	// Move to history
	await db
		.prepare(
			`INSERT INTO alerts_history (
				alert_id, alert_type, severity, source_id, run_id,
				message, recommended_action, created_at, resolved_at, resolution_note
			)
			SELECT
				alert_id, alert_type, severity, source_id, run_id,
				message, recommended_action, created_at, ?, ?
			FROM alerts_active
			WHERE alert_id = ?`,
		)
		.bind(now, resolutionNote ?? null, alertId)
		.run();

	// Remove from active
	const result = await db
		.prepare("DELETE FROM alerts_active WHERE alert_id = ?")
		.bind(alertId)
		.run();

	return result.success && (result.meta?.changes ?? 0) > 0;
}

// Alert evaluation functions
export async function evaluateSourceFailureRate(
	db: D1Database,
	sourceId: string,
	threshold: number,
	windowSeconds: number,
): Promise<{ triggered: boolean; actualRate?: number; message?: string }> {
	const since = Math.floor(Date.now() / 1000) - windowSeconds;

	const result = await db
		.prepare(
			`SELECT
				COUNT(*) as total,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failures
			FROM ingest_runs
			WHERE source_id = ? AND created_at >= ?`,
		)
		.bind(sourceId, since)
		.first<{ total: number; failures: number }>();

	if (!result || result.total === 0) {
		return { triggered: false };
	}

	const failureRate = result.failures / result.total;
	if (failureRate >= threshold) {
		return {
			triggered: true,
			actualRate: failureRate,
			message: `Source ${sourceId} failure rate is ${(failureRate * 100).toFixed(1)}% (${result.failures}/${result.total} runs) in last ${windowSeconds}s`,
		};
	}

	return { triggered: false, actualRate: failureRate };
}

export async function evaluateQueueLag(
	db: D1Database,
	thresholdSeconds: number,
): Promise<{ triggered: boolean; actualLag?: number; message?: string }> {
	// Get oldest unprocessed run
	const result = await db
		.prepare(
			`SELECT received_at, (unixepoch() - unixepoch(received_at)) as lag_seconds
			FROM ingest_runs
			WHERE status IN ('received', 'collecting', 'enqueued')
			ORDER BY received_at ASC
			LIMIT 1`,
		)
		.first<{ received_at: string; lag_seconds: number }>();

	if (!result) {
		return { triggered: false };
	}

	const lagSeconds = result.lag_seconds;
	if (lagSeconds >= thresholdSeconds) {
		return {
			triggered: true,
			actualLag: lagSeconds,
			message: `Queue lag is ${lagSeconds}s (oldest unprocessed run from ${result.received_at})`,
		};
	}

	return { triggered: false, actualLag: lagSeconds };
}

export async function evaluateStuckRuns(
	db: D1Database,
	thresholdSeconds: number,
): Promise<
	Array<{
		runId: string;
		sourceId: string;
		status: string;
		stuckSeconds: number;
		message: string;
	}>
> {
	const since = Math.floor(Date.now() / 1000) - thresholdSeconds;

	const result = await db
		.prepare(
			`SELECT
				run_id, source_id, status,
				COALESCE(
					unixepoch() - unixepoch(received_at),
					unixepoch() - created_at
				) as stuck_seconds
			FROM ingest_runs
			WHERE status IN ('collecting', 'enqueued', 'persisted')
			AND created_at < ?
			ORDER BY created_at ASC`,
		)
		.bind(since)
		.all<{
			run_id: string;
			source_id: string;
			status: string;
			stuck_seconds: number;
		}>();

	return (result.results ?? []).map((row) => ({
		runId: row.run_id,
		sourceId: row.source_id,
		status: row.status,
		stuckSeconds: row.stuck_seconds,
		message: `Run ${row.run_id} stuck in ${row.status} for ${row.stuck_seconds}s`,
	}));
}

export async function evaluateExpiredLeases(
	db: D1Database,
): Promise<
	Array<{
		sourceId: string;
		leaseOwner: string | null;
		leaseExpiresAt: number;
		expiredSeconds: number;
		message: string;
	}>
> {
	const now = Math.floor(Date.now() / 1000);

	const result = await db
		.prepare(
			`SELECT
				source_id, lease_owner, lease_expires_at,
				? - lease_expires_at as expired_seconds
			FROM source_runtime_snapshots
			WHERE lease_expires_at IS NOT NULL
			AND lease_expires_at < ?
			ORDER BY lease_expires_at ASC`,
		)
		.bind(now, now)
		.all<{
			source_id: string;
			lease_owner: string | null;
			lease_expires_at: number;
			expired_seconds: number;
		}>();

	return (result.results ?? []).map((row) => ({
		sourceId: row.source_id,
		leaseOwner: row.lease_owner,
		leaseExpiresAt: row.lease_expires_at,
		expiredSeconds: row.expired_seconds,
		message: `Source ${row.source_id} lease expired ${row.expired_seconds}s ago (held by ${row.lease_owner ?? "unknown"})`,
	}));
}

export async function runAllAlertChecks(
	db: D1Database,
	alertConfig: AlertConfiguration,
	env?: Env,
): Promise<{ alertsCreated: number; checksRun: number; errors: string[] }> {
	const errors: string[] = [];
	let alertsCreated = 0;
	let checksRun = 0;

	const enabledRules = alertConfig.alertRules.filter((r) => r.enabled);

	for (const rule of enabledRules) {
		try {
			switch (rule.alertType) {
				case "source_failure_rate": {
					// Get all active sources
					const sources = await db
						.prepare(
							"SELECT source_id, name FROM source_configs WHERE status = 'active'",
						)
						.all<{ source_id: string; name: string }>();

					for (const source of sources.results ?? []) {
						checksRun++;
						const evalResult = await evaluateSourceFailureRate(
							db,
							source.source_id,
							rule.threshold,
							rule.windowSeconds,
						);

						if (evalResult.triggered) {
							const createResult = await createAlert(db, {
								alertType: rule.alertType,
								severity: rule.severity,
								sourceId: source.source_id,
								message: evalResult.message!,
								recommendedAction: getRecommendedAction(rule.alertType, rule.severity),
								acknowledged: false,
							}, env, alertConfig, source.name);
							if (createResult.created) alertsCreated++;
						}
					}
					break;
				}

				case "queue_lag": {
					checksRun++;
					const evalResult = await evaluateQueueLag(db, rule.threshold);

					if (evalResult.triggered) {
						const createResult = await createAlert(db, {
							alertType: rule.alertType,
							severity: rule.severity,
							message: evalResult.message!,
							recommendedAction: getRecommendedAction(rule.alertType, rule.severity),
							acknowledged: false,
						}, env, alertConfig);
						if (createResult.created) alertsCreated++;
					}
					break;
				}

				case "run_stuck": {
					checksRun++;
					const stuckRuns = await evaluateStuckRuns(db, rule.threshold);

					for (const stuck of stuckRuns) {
						const createResult = await createAlert(db, {
							alertType: rule.alertType,
							severity: rule.severity,
							sourceId: stuck.sourceId,
							runId: stuck.runId,
							message: stuck.message,
							recommendedAction: getRecommendedAction(rule.alertType, rule.severity),
							acknowledged: false,
						}, env, alertConfig);
						if (createResult.created) alertsCreated++;
					}
					break;
				}

				case "lease_expired": {
					checksRun++;
					const expiredLeases = await evaluateExpiredLeases(db);

					for (const expired of expiredLeases) {
						const createResult = await createAlert(db, {
							alertType: rule.alertType,
							severity: rule.severity,
							sourceId: expired.sourceId,
							message: expired.message,
							recommendedAction: getRecommendedAction(rule.alertType, rule.severity),
							acknowledged: false,
						}, env, alertConfig);
						if (createResult.created) alertsCreated++;
					}
					break;
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			errors.push(`Alert check ${rule.alertType} failed: ${msg}`);
		}
	}

	return { alertsCreated, checksRun, errors };
}

function getRecommendedAction(alertType: AlertType, severity: AlertSeverity): string {
	const actions: Record<AlertType, Record<AlertSeverity, string>> = {
		source_failure_rate: {
			warning:
				"Monitor source health. Check recent error logs for patterns. Consider temporary rate limiting.",
			critical:
				"Immediately investigate source. Consider pausing source or switching to fallback endpoint. Check adapter configuration.",
		},
		queue_lag: {
			warning:
				"Scale queue workers if possible. Check for processing bottlenecks in normalization pipeline.",
			critical:
				"Emergency scale-up required. Consider shedding load or enabling circuit breaker. Review recent deployment changes.",
		},
		run_stuck: {
			warning:
				"Check workflow instance status. May need manual intervention or lease release.",
			critical:
				"Force-release lease and trigger recovery workflow. Investigate underlying infrastructure issues.",
		},
		lease_expired: {
			warning: "Release expired lease and retry collection.",
			critical:
				"Force-release lease immediately. Check coordinator health and source configuration.",
		},
	};

	return actions[alertType]?.[severity] ?? "Investigate and take appropriate action.";
}

// Auto-resolve alerts when conditions clear
export async function autoResolveAlerts(db: D1Database): Promise<number> {
	const now = Math.floor(Date.now() / 1000);

	// Resolve failure rate alerts for sources with recent success
	await db
		.prepare(
			`UPDATE alerts_active
			SET acknowledged = 1
			WHERE alert_type = 'source_failure_rate'
			AND acknowledged = 0
			AND source_id IN (
				SELECT source_id FROM ingest_runs
				WHERE status = 'normalized'
				AND created_at >= unixepoch() - 300
				GROUP BY source_id
				HAVING COUNT(*) >= 3
			)`,
		)
		.run();

	// Move old acknowledged alerts to history (older than 24 hours)
	const dayAgo = now - 86400;
	await db
		.prepare(
			`INSERT INTO alerts_history (
				alert_id, alert_type, severity, source_id, run_id,
				message, recommended_action, created_at, resolved_at, resolution_note
			)
			SELECT
				alert_id, alert_type, severity, source_id, run_id,
				message, recommended_action, created_at, ?, 'Auto-resolved: age'
			FROM alerts_active
			WHERE acknowledged = 1 AND created_at < ?`,
		)
		.bind(now, dayAgo)
		.run();

	const result = await db
		.prepare("DELETE FROM alerts_active WHERE acknowledged = 1 AND created_at < ?")
		.bind(dayAgo)
		.run();

	return result.meta?.changes ?? 0;
}
