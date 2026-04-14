import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type { Alert } from "../lib/alerting";
import type { ProviderWithId, NotificationRoute } from "../lib/notifications/types";
import { dispatchNotifications } from "../lib/notifications/dispatcher";

interface RateLimitState {
	lastSentAt: number;
	countInWindow: number;
}

interface RetryJob {
	alert: Alert;
	providers: ProviderWithId[];
	routes: NotificationRoute[];
	sourceName?: string;
	attempt: number;
	retryAfter: number;
}

const RETRY_INTERVAL_MS = 10_000;
const MAX_RETRY_QUEUE_SIZE = 1000;

export class NotificationDispatcher extends DurableObject {
	private rateLimits: Map<string, RateLimitState> = new Map();
	private retryQueue: RetryJob[] = [];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async dispatch(
		alert: Alert,
		providers: ProviderWithId[],
		routes: NotificationRoute[],
		sourceName?: string,
	): Promise<{ sent: number; failed: number; throttled: number; errors: string[] }> {
		const now = Date.now();
		const windowMs = 60_000; // 1 minute rate limit window
		const maxPerWindow = 10; // max 10 notifications per provider per minute
		const throttledRoutes: NotificationRoute[] = [];
		const activeRoutes: NotificationRoute[] = [];

		for (const route of routes) {
			if (!route.enabled) continue;

			const state = this.rateLimits.get(route.providerId) ?? { lastSentAt: 0, countInWindow: 0 };

			// Reset window if expired
			if (now - state.lastSentAt > windowMs) {
				state.countInWindow = 0;
			}

			if (state.countInWindow >= maxPerWindow) {
				throttledRoutes.push(route);
			} else {
				state.countInWindow++;
				state.lastSentAt = now;
				this.rateLimits.set(route.providerId, state);
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
			errors: result.errors,
		};
	}

	async alarm(): Promise<void> {
		try {
			const hadWork = await this.processRetries();
			if (hadWork || this.retryQueue.length > 0) {
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

	private enqueueRetry(job: RetryJob): void {
		if (this.retryQueue.length >= MAX_RETRY_QUEUE_SIZE) {
			console.error("[NotificationDispatcher] Retry queue full, dropping oldest job");
			this.retryQueue.shift();
		}
		this.retryQueue.push(job);
	}

	private async ensureAlarm(): Promise<void> {
		const alarm = await this.ctx.storage.getAlarm();
		if (!alarm && this.retryQueue.length > 0) {
			await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
		}
	}

	private async processRetries(): Promise<boolean> {
		const now = Date.now();
		const ready = this.retryQueue.filter((job) => job.retryAfter <= now);
		this.retryQueue = this.retryQueue.filter((job) => job.retryAfter > now);

		if (ready.length === 0) return false;

		for (const job of ready) {
			if (job.attempt > 3) {
				console.error("[NotificationDispatcher] Max retries exceeded for alert", job.alert.alertId);
				continue;
			}

			const result = await dispatchNotifications(job.providers, job.routes, job.alert, job.sourceName);

			for (const delivery of result.deliveries) {
				if (!delivery.sent) {
					this.enqueueRetry({
						...job,
						routes: job.routes.filter((r) => r.providerId === delivery.providerId),
						attempt: job.attempt + 1,
						retryAfter: now + job.attempt * 60_000,
					});
				}
			}
		}

		return true;
	}
}
