import { DurableObject } from "cloudflare:workers";
import type { Env, RuntimeSnapshot } from "../types";
import { writeCoordinatorMetrics } from "../lib/metrics";

/**
 * Enhanced SourceCoordinator with backpressure and capacity management
 * 
 * For daily production use, this prevents:
 * - Runaway sources consuming all resources
 * - Cascading failures from overloaded systems
 * - Silent degradation without visibility
 */

type LeaseAcquirePayload = {
	requestedBy: string;
	ttlSeconds: number;
	force?: boolean;
	sourceId?: string;
	estimatedRecords?: number;
};

type LeaseReleasePayload = {
	leaseToken: string;
};

type CursorAdvancePayload = {
	leaseToken: string;
	cursor?: string;
	runId?: string;
};

type SuccessPayload = {
	leaseToken: string;
	runId: string;
	cursor?: string;
	recordCount?: number;
};

type FailurePayload = {
	leaseToken: string;
	runId?: string;
	errorMessage: string;
};

// Backpressure configuration
const BACKPRESSURE_CONFIG = {
	maxConsecutiveFailures: 5, // Auto-pause source after this many failures
	failureCooldownMs: 60000, // Wait 1 minute after failures before allowing new lease
	maxRecordsPerRun: 10000, // Hard limit on records per run
	rateLimitWindowMs: 60000, // 1 minute window for rate limiting
	minIntervalBetweenRunsMs: 5000, // Minimum 5 seconds between runs
};

const SNAPSHOT_KEY = "snapshot";
const BACKPRESSURE_KEY = "backpressure";

interface BackpressureState {
	consecutiveFailures: number;
	lastFailureAt: number;
	totalRunsInWindow: number;
	windowStartAt: number;
	lastRunAt: number;
	pausedUntil?: number;
	pauseReason?: string;
}

export class SourceCoordinator extends DurableObject<Env> {
	private snapshot: RuntimeSnapshot;
	private backpressure: BackpressureState;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.snapshot = {
			sourceId: ctx.id.name ?? ctx.id.toString(),
			consecutiveFailures: 0,
			updatedAt: Date.now(),
		};

		this.backpressure = {
			consecutiveFailures: 0,
			lastFailureAt: 0,
			totalRunsInWindow: 0,
			windowStartAt: Date.now(),
			lastRunAt: 0,
		};

		ctx.blockConcurrencyWhile(async () => {
			const persistedSnapshot = await this.ctx.storage.get<RuntimeSnapshot>(SNAPSHOT_KEY);
			if (persistedSnapshot) {
				this.snapshot = persistedSnapshot;
			}
			
			const persistedBackpressure = await this.ctx.storage.get<BackpressureState>(BACKPRESSURE_KEY);
			if (persistedBackpressure) {
				this.backpressure = persistedBackpressure;
			}
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/state") {
			return Response.json({
				...this.snapshot,
				backpressure: this.getBackpressureStatus(),
			});
		}

		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json(this.getHealthStatus());
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const body = await request.json().catch(() => null);
		if (!body) {
			return new Response("Invalid JSON body", { status: 400 });
		}

		// Wrap all mutating operations in blockConcurrencyWhile for atomicity
		return this.ctx.blockConcurrencyWhile(async () => {
			try {
				switch (url.pathname) {
					case "/lease/acquire":
						return Response.json(await this.handleAcquireLease(body));
					case "/lease/release":
						return Response.json(await this.handleReleaseLease(body));
					case "/cursor/advance":
						return Response.json(await this.handleAdvanceCursor(body));
					case "/state/success":
						return Response.json(await this.handleSuccess(body));
					case "/state/failure":
						return Response.json(await this.handleFailure(body));
					case "/admin/unpause":
						return Response.json(await this.handleUnpause());
					default:
						return new Response("Not Found", { status: 404 });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "Coordinator operation failed";
				if (
					message.includes("Invalid lease token") ||
					message.includes("Lease expired") ||
					message.includes("Backpressure")
				) {
					return new Response(message, { status: 409 });
				}

				return new Response(message, { status: 500 });
			}
		});
	}

	// === Native DO RPC methods ===
	// These provide type-safe, HTTP-free access to coordinator operations.
	// Callers use: await coordinator.acquireLease(params) instead of coordinator.fetch(url, {method:'POST'})

	async acquireLease(params: LeaseAcquirePayload) {
		return this.ctx.blockConcurrencyWhile(() => this.handleAcquireLease(params));
	}

	async releaseLease(params: LeaseReleasePayload) {
		return this.ctx.blockConcurrencyWhile(() => this.handleReleaseLease(params));
	}

	async advanceCursor(params: CursorAdvancePayload) {
		return this.ctx.blockConcurrencyWhile(() => this.handleAdvanceCursor(params));
	}

	async recordSuccess(params: SuccessPayload) {
		return this.ctx.blockConcurrencyWhile(() => this.handleSuccess(params));
	}

	async recordFailure(params: FailurePayload) {
		return this.ctx.blockConcurrencyWhile(() => this.handleFailure(params));
	}

	async unpause() {
		return this.ctx.blockConcurrencyWhile(() => this.handleUnpause());
	}

	async getState() {
		return { ...this.snapshot, backpressure: this.getBackpressureStatus() };
	}

	async getHealth() {
		return this.getHealthStatus();
	}

	private async handleAcquireLease(input: unknown): Promise<{
		acquired: boolean;
		leaseToken?: string;
		reason?: string;
		expiresAt?: number;
		backpressure?: {
			isPaused: boolean;
			pausedUntil?: number;
			pauseReason?: string;
			consecutiveFailures: number;
		};
	}> {
		const payload = input as LeaseAcquirePayload;
		const now = Date.now();

		// Check backpressure - is source paused?
		if (this.backpressure.pausedUntil && now < this.backpressure.pausedUntil && !payload.force) {
			return {
				acquired: false,
				reason: `Source paused: ${this.backpressure.pauseReason}`,
				backpressure: {
					isPaused: true,
					pausedUntil: this.backpressure.pausedUntil,
					pauseReason: this.backpressure.pauseReason,
					consecutiveFailures: this.backpressure.consecutiveFailures,
				},
			};
		}

		// Check rate limiting
		if (!payload.force) {
			// Reset window if needed
			if (now - this.backpressure.windowStartAt > BACKPRESSURE_CONFIG.rateLimitWindowMs) {
				this.backpressure.totalRunsInWindow = 0;
				this.backpressure.windowStartAt = now;
			}

			// Check minimum interval
			if (now - this.backpressure.lastRunAt < BACKPRESSURE_CONFIG.minIntervalBetweenRunsMs) {
				return {
					acquired: false,
					reason: `Rate limited: minimum interval between runs is ${BACKPRESSURE_CONFIG.minIntervalBetweenRunsMs}ms`,
					backpressure: this.getBackpressureStatus(),
				};
			}

			// Check record limit estimate
			if (payload.estimatedRecords && payload.estimatedRecords > BACKPRESSURE_CONFIG.maxRecordsPerRun) {
				return {
					acquired: false,
					reason: `Too many records: ${payload.estimatedRecords} > ${BACKPRESSURE_CONFIG.maxRecordsPerRun} limit`,
					backpressure: this.getBackpressureStatus(),
				};
			}
		}

		// Check existing lease
		if (this.snapshot.leaseToken && this.snapshot.leaseExpiresAt && this.snapshot.leaseExpiresAt > now && !payload.force) {
			return {
				acquired: false,
				reason: "Lease already active",
				expiresAt: this.snapshot.leaseExpiresAt,
				backpressure: this.getBackpressureStatus(),
			};
		}

		// Check failure cooldown
		if (!payload.force && this.backpressure.consecutiveFailures > 0) {
			const timeSinceLastFailure = now - this.backpressure.lastFailureAt;
			if (timeSinceLastFailure < BACKPRESSURE_CONFIG.failureCooldownMs) {
				const remainingCooldown = BACKPRESSURE_CONFIG.failureCooldownMs - timeSinceLastFailure;
				return {
					acquired: false,
					reason: `Cooldown after ${this.backpressure.consecutiveFailures} consecutive failures. Retry in ${Math.ceil(remainingCooldown / 1000)}s`,
					backpressure: this.getBackpressureStatus(),
				};
			}
		}

		// Grant lease
		const ttl = Math.max(1, Math.min(payload.ttlSeconds || 300, 3600));
		const leaseToken = crypto.randomUUID();
		const sourceId = payload.sourceId ?? this.snapshot.sourceId;

		this.snapshot = {
			...this.snapshot,
			sourceId,
			leaseOwner: payload.requestedBy || "unknown",
			leaseToken,
			leaseExpiresAt: now + ttl * 1000,
			updatedAt: now,
		};

		this.backpressure.lastRunAt = now;
		this.backpressure.totalRunsInWindow++;
		this.backpressure.pausedUntil = undefined;
		this.backpressure.pauseReason = undefined;

		await this.persist();

		writeCoordinatorMetrics(this.env, {
			sourceId: this.snapshot.sourceId,
			event: "lease_acquired",
		});

		return {
			acquired: true,
			leaseToken,
			expiresAt: this.snapshot.leaseExpiresAt,
			backpressure: this.getBackpressureStatus(),
		};
	}

	private async handleReleaseLease(input: unknown): Promise<{ released: boolean }> {
		const payload = input as LeaseReleasePayload;
		if (!payload?.leaseToken || payload.leaseToken !== this.snapshot.leaseToken) {
			return { released: false };
		}

		this.snapshot = {
			...this.snapshot,
			leaseOwner: undefined,
			leaseToken: undefined,
			leaseExpiresAt: undefined,
			updatedAt: Date.now(),
		};
		await this.persist();

		writeCoordinatorMetrics(this.env, {
			sourceId: this.snapshot.sourceId,
			event: "lease_released",
		});

		return { released: true };
	}

	private async handleAdvanceCursor(input: unknown): Promise<RuntimeSnapshot> {
		const payload = input as CursorAdvancePayload;
		this.ensureActiveLease(payload.leaseToken);

		this.snapshot = {
			...this.snapshot,
			cursor: payload.cursor,
			lastRunId: payload.runId ?? this.snapshot.lastRunId,
			updatedAt: Date.now(),
		};
		await this.persist();

		writeCoordinatorMetrics(this.env, {
			sourceId: this.snapshot.sourceId,
			event: "cursor_advanced",
		});

		return this.snapshot;
	}

	private async handleSuccess(input: unknown): Promise<RuntimeSnapshot> {
		const payload = input as SuccessPayload;
		this.ensureActiveLease(payload.leaseToken);

		this.snapshot = {
			...this.snapshot,
			cursor: payload.cursor ?? this.snapshot.cursor,
			lastRunId: payload.runId,
			lastSuccessAt: new Date().toISOString(),
			consecutiveFailures: 0,
			leaseOwner: undefined,
			leaseToken: undefined,
			leaseExpiresAt: undefined,
			updatedAt: Date.now(),
		};

		// Reset backpressure on success
		this.backpressure.consecutiveFailures = 0;
		this.backpressure.pausedUntil = undefined;
		this.backpressure.pauseReason = undefined;

		await this.persist();

		writeCoordinatorMetrics(this.env, {
			sourceId: this.snapshot.sourceId,
			event: "success",
		});

		return this.snapshot;
	}

	private async handleFailure(input: unknown): Promise<RuntimeSnapshot> {
		const payload = input as FailurePayload;
		if (payload?.leaseToken && payload.leaseToken !== this.snapshot.leaseToken) {
			throw new Error("Invalid lease token for failure recording");
		}

		const now = Date.now();
		const consecutiveFailures = (this.backpressure.consecutiveFailures ?? 0) + 1;

		this.snapshot = {
			...this.snapshot,
			lastRunId: payload.runId ?? this.snapshot.lastRunId,
			lastErrorAt: new Date().toISOString(),
			lastErrorMessage: payload.errorMessage,
			consecutiveFailures,
			leaseOwner: undefined,
			leaseToken: undefined,
			leaseExpiresAt: undefined,
			updatedAt: now,
		};

		// Update backpressure (keep in sync with snapshot)
		this.backpressure.consecutiveFailures = consecutiveFailures;
		this.backpressure.lastFailureAt = now;

		// Auto-pause if too many consecutive failures
		if (this.backpressure.consecutiveFailures >= BACKPRESSURE_CONFIG.maxConsecutiveFailures) {
			this.backpressure.pausedUntil = now + BACKPRESSURE_CONFIG.failureCooldownMs * 2;
			this.backpressure.pauseReason = `Auto-paused after ${this.backpressure.consecutiveFailures} consecutive failures`;
			
			console.warn(`[SourceCoordinator:${this.snapshot.sourceId}] Auto-paused source due to failures`, {
				consecutiveFailures: this.backpressure.consecutiveFailures,
				pausedUntil: this.backpressure.pausedUntil,
			});
		}

		await this.persist();

		writeCoordinatorMetrics(this.env, {
			sourceId: this.snapshot.sourceId,
			event: "failure",
			consecutiveFailures,
		});

		return this.snapshot;
	}

	private async handleUnpause(): Promise<{ unpaused: boolean; reason?: string }> {
		if (!this.backpressure.pausedUntil) {
			return { unpaused: false, reason: "Source was not paused" };
		}

		this.backpressure.pausedUntil = undefined;
		this.backpressure.pauseReason = undefined;
		this.backpressure.consecutiveFailures = 0;
		
		await this.persistBackpressure();

		console.log(`[SourceCoordinator:${this.snapshot.sourceId}] Manually unpaused`);

		return { unpaused: true };
	}

	private ensureActiveLease(leaseToken: string): void {
		if (!leaseToken || leaseToken !== this.snapshot.leaseToken) {
			throw new Error("Invalid lease token");
		}
		if (!this.snapshot.leaseExpiresAt || this.snapshot.leaseExpiresAt < Date.now()) {
			throw new Error("Lease expired");
		}
	}

	private getBackpressureStatus() {
		return {
			isPaused: this.backpressure.pausedUntil ? Date.now() < this.backpressure.pausedUntil : false,
			pausedUntil: this.backpressure.pausedUntil,
			pauseReason: this.backpressure.pauseReason,
			consecutiveFailures: this.backpressure.consecutiveFailures,
			runsInWindow: this.backpressure.totalRunsInWindow,
			lastRunAt: this.backpressure.lastRunAt,
		};
	}

	private getHealthStatus() {
		const now = Date.now();
		const isPaused = this.backpressure.pausedUntil ? now < this.backpressure.pausedUntil : false;
		
		return {
			sourceId: this.snapshot.sourceId,
			status: isPaused ? "paused" : this.snapshot.leaseToken ? "active" : "idle",
			healthy: !isPaused && this.backpressure.consecutiveFailures < 3,
			backpressure: this.getBackpressureStatus(),
			lease: this.snapshot.leaseToken ? {
				owner: this.snapshot.leaseOwner,
				expiresAt: this.snapshot.leaseExpiresAt,
			} : null,
			lastSuccess: this.snapshot.lastSuccessAt,
			lastError: this.snapshot.lastErrorAt,
			cursor: this.snapshot.cursor,
		};
	}

	private async persist(): Promise<void> {
		await this.ctx.storage.put(SNAPSHOT_KEY, this.snapshot);
		await this.persistBackpressure();
	}

	private async persistBackpressure(): Promise<void> {
		await this.ctx.storage.put(BACKPRESSURE_KEY, this.backpressure);
	}
}

// Export backpressure config for external use
export { BACKPRESSURE_CONFIG };
