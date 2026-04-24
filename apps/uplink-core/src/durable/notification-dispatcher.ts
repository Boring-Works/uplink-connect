import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type { Alert } from "../lib/alerting";
import type { ProviderWithId, NotificationRoute } from "../lib/notifications/types";
import { dispatchNotifications } from "../lib/notifications/dispatcher";

const RETRY_INTERVAL_MS = 10_000;
const MAX_RETRY_QUEUE_SIZE = 1000;

function getAlertDedupKey(alert: Alert, route: NotificationRoute): string {
	return `alert-dedup:${alert.sourceId ?? "system"}:${alert.alertId}:${route.providerId}`;
}

export class NotificationDispatcher extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.ensureSchema();
		});
	}

	private ensureSchema(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS retry_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				alert_json TEXT NOT NULL,
				routes_json TEXT NOT NULL,
				providers_json TEXT NOT NULL,
				source_name TEXT,
				attempt INTEGER NOT NULL DEFAULT 1,
				retry_after INTEGER NOT NULL
			)
		`);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS rate_limits (
				provider_id TEXT PRIMARY KEY,
				count_in_window INTEGER NOT NULL DEFAULT 0,
				last_sent_at INTEGER NOT NULL DEFAULT 0
			)
		`);
		this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_retry_after ON retry_queue(retry_after)`);
	}

	async dispatch(
		alert: Alert,
		providers: ProviderWithId[],
		routes: NotificationRoute[],
		sourceName?: string,
	): Promise<{ sent: number; failed: number; throttled: number; deduplicated: number; errors: string[] }> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const now = Date.now();
			const windowMs = 60_000; // 1 minute rate limit window
			const maxPerWindow = 10; // max 10 notifications per provider per minute
			const throttledRoutes: NotificationRoute[] = [];
			const activeRoutes: NotificationRoute[] = [];
			const deduplicatedRoutes: NotificationRoute[] = [];

			for (const route of routes) {
				if (!route.enabled) continue;

				// KV deduplication check
				if (this.env.ALERT_CACHE) {
					try {
						const dedupKey = getAlertDedupKey(alert, route);
						const cached = await this.env.ALERT_CACHE.get(dedupKey);
						if (cached !== null) {
							deduplicatedRoutes.push(route);
							continue;
						}
						// Mark as sent with 1-hour TTL
						await this.env.ALERT_CACHE.put(dedupKey, "1", { expirationTtl: 3600 });
					} catch (err) {
						// If KV fails, proceed with dispatch rather than dropping the alert
						console.warn("[NotificationDispatcher] KV dedup check failed, proceeding:", err);
					}
				}

				// Read rate limit state from SQL
				let countInWindow = 0;
				let lastSentAt = 0;
				for (const row of this.sql.exec(
					`SELECT count_in_window, last_sent_at FROM rate_limits WHERE provider_id = ?`,
					route.providerId
				)) {
					countInWindow = row.count_in_window as number;
					lastSentAt = row.last_sent_at as number;
				}

				// Reset window if expired
				if (now - lastSentAt > windowMs) {
					countInWindow = 0;
				}

				if (countInWindow >= maxPerWindow) {
					throttledRoutes.push(route);
				} else {
					countInWindow++;
					lastSentAt = now;
					this.sql.exec(
						`INSERT INTO rate_limits (provider_id, count_in_window, last_sent_at)
						 VALUES (?, ?, ?)
						 ON CONFLICT(provider_id) DO UPDATE SET
							 count_in_window = excluded.count_in_window,
							 last_sent_at = excluded.last_sent_at`,
						route.providerId,
						countInWindow,
						lastSentAt
					);
					activeRoutes.push(route);
				}
			}

			// Dispatch non-throttled notifications immediately
			const result = await dispatchNotifications(providers, activeRoutes, alert, sourceName);

			// Queue throttled notifications for retry
			for (const route of throttledRoutes) {
				this.enqueueRetry({
					alert,
					providers,
					routes: [route],
					sourceName,
					attempt: 1,
					retryAfter: now + windowMs,
				});
			}

			// Queue failed deliveries for retry
			for (const delivery of result.deliveries) {
				if (!delivery.sent) {
					this.enqueueRetry({
						alert,
						providers,
						routes: activeRoutes.filter((r) => r.providerId === delivery.providerId),
						sourceName,
						attempt: 1,
						retryAfter: now + 30_000,
					});
				}
			}

			await this.ensureAlarm();

			return {
				sent: result.sent,
				failed: result.failed,
				throttled: throttledRoutes.length,
				deduplicated: deduplicatedRoutes.length,
				errors: result.errors,
			};
		});
	}

	async alarm(): Promise<void> {
		try {
			const hadWork = await this.processRetries();
			const count = this.retryQueueCount();
			if (hadWork || count > 0) {
				await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[NotificationDispatcher] alarm failed:", message);
			// Reschedule alarm even on failure so we don't get stuck
			try {
				await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
			} catch (alarmErr) {
				console.error("[NotificationDispatcher] Failed to reschedule alarm:", alarmErr);
			}
		}
	}

	private enqueueRetry(job: {
		alert: Alert;
		providers: ProviderWithId[];
		routes: NotificationRoute[];
		sourceName?: string;
		attempt: number;
		retryAfter: number;
	}): void {
		// Enforce max queue size by dropping oldest entries
		const count = this.retryQueueCount();
		if (count >= MAX_RETRY_QUEUE_SIZE) {
			console.error("[NotificationDispatcher] Retry queue full, dropping oldest job");
			this.sql.exec(`DELETE FROM retry_queue WHERE id = (SELECT id FROM retry_queue ORDER BY retry_after ASC LIMIT 1)`);
		}

		this.sql.exec(
			`INSERT INTO retry_queue (alert_json, routes_json, providers_json, source_name, attempt, retry_after)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			JSON.stringify(job.alert),
			JSON.stringify(job.routes),
			JSON.stringify(job.providers),
			job.sourceName ?? null,
			job.attempt,
			job.retryAfter
		);
	}

	private retryQueueCount(): number {
		for (const row of this.sql.exec(`SELECT COUNT(*) as c FROM retry_queue`)) {
			return (row.c as number) ?? 0;
		}
		return 0;
	}

	private async ensureAlarm(): Promise<void> {
		const alarm = await this.ctx.storage.getAlarm();
		if (!alarm && this.retryQueueCount() > 0) {
			await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
		}
	}

	private async processRetries(): Promise<boolean> {
		const now = Date.now();
		const rows = this.sql.exec(
			`SELECT id, alert_json, routes_json, providers_json, source_name, attempt
			 FROM retry_queue WHERE retry_after <= ?`,
			now
		) as Iterable<{
			id: number;
			alert_json: string;
			routes_json: string;
			providers_json: string;
			source_name: string | null;
			attempt: number;
		}>;

		let hadWork = false;
		for (const row of rows) {
			hadWork = true;

			if (row.attempt > 3) {
				console.error("[NotificationDispatcher] Max retries exceeded for alert", row.alert_json);
				this.sql.exec(`DELETE FROM retry_queue WHERE id = ?`, row.id);
				continue;
			}

			let alert: Alert;
			let routes: NotificationRoute[];
			let providers: ProviderWithId[];
			try {
				alert = JSON.parse(row.alert_json) as Alert;
				routes = JSON.parse(row.routes_json) as NotificationRoute[];
				providers = JSON.parse(row.providers_json) as ProviderWithId[];
			} catch (parseErr) {
				console.error("[NotificationDispatcher] Failed to parse retry job, dropping:", parseErr);
				this.sql.exec(`DELETE FROM retry_queue WHERE id = ?`, row.id);
				continue;
			}

			const result = await dispatchNotifications(providers, routes, alert, row.source_name ?? undefined);

			// Delete the original job first
			this.sql.exec(`DELETE FROM retry_queue WHERE id = ?`, row.id);

			for (const delivery of result.deliveries) {
				if (!delivery.sent) {
					this.enqueueRetry({
						alert,
						providers,
						routes: routes.filter((r) => r.providerId === delivery.providerId),
						sourceName: row.source_name ?? undefined,
						attempt: row.attempt + 1,
						retryAfter: now + row.attempt * 60_000,
					});
				}
			}
		}

		return hadWork;
	}
}
