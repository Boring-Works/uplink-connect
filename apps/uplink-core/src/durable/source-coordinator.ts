import { DurableObject } from "cloudflare:workers";
import type { Env, RuntimeSnapshot } from "../types";
import { writeCoordinatorMetrics } from "../lib/metrics";

type LeaseAcquirePayload = {
	requestedBy: string;
	ttlSeconds: number;
	force?: boolean;
	sourceId?: string;
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
};

type FailurePayload = {
	leaseToken: string;
	runId?: string;
	errorMessage: string;
};

const SNAPSHOT_KEY = "snapshot";

export class SourceCoordinator extends DurableObject<Env> {
	private snapshot: RuntimeSnapshot;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.snapshot = {
			sourceId: ctx.id.name ?? ctx.id.toString(),
			consecutiveFailures: 0,
			updatedAt: Date.now(),
		};

		ctx.blockConcurrencyWhile(async () => {
			const persisted = await this.ctx.storage.get<RuntimeSnapshot>(SNAPSHOT_KEY);
			if (persisted) {
				this.snapshot = persisted;
			}
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/state") {
			return Response.json(this.snapshot);
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const body = await request.json().catch(() => null);

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
				default:
					return new Response("Not Found", { status: 404 });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Coordinator operation failed";
			if (
				message.includes("Invalid lease token") ||
				message.includes("Lease expired")
			) {
				return new Response(message, { status: 409 });
			}

			return new Response(message, { status: 500 });
		}
	}

	private async handleAcquireLease(input: unknown): Promise<{
		acquired: boolean;
		leaseToken?: string;
		reason?: string;
		expiresAt?: number;
	}> {
		const payload = input as LeaseAcquirePayload;
		const now = Date.now();

		if (this.snapshot.leaseToken && this.snapshot.leaseExpiresAt && this.snapshot.leaseExpiresAt > now && !payload.force) {
			return {
				acquired: false,
				reason: "Lease already active",
				expiresAt: this.snapshot.leaseExpiresAt,
			};
		}

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

		await this.persist();

		writeCoordinatorMetrics(this.env, {
			sourceId: this.snapshot.sourceId,
			event: "lease_acquired",
		});

		return {
			acquired: true,
			leaseToken,
			expiresAt: this.snapshot.leaseExpiresAt,
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

		const consecutiveFailures = (this.snapshot.consecutiveFailures ?? 0) + 1;

		this.snapshot = {
			...this.snapshot,
			lastRunId: payload.runId ?? this.snapshot.lastRunId,
			lastErrorAt: new Date().toISOString(),
			lastErrorMessage: payload.errorMessage,
			consecutiveFailures,
			leaseOwner: undefined,
			leaseToken: undefined,
			leaseExpiresAt: undefined,
			updatedAt: Date.now(),
		};

		await this.persist();

		writeCoordinatorMetrics(this.env, {
			sourceId: this.snapshot.sourceId,
			event: "failure",
			consecutiveFailures,
		});

		return this.snapshot;
	}

	private ensureActiveLease(leaseToken: string): void {
		if (!leaseToken || leaseToken !== this.snapshot.leaseToken) {
			throw new Error("Invalid lease token");
		}
		if (!this.snapshot.leaseExpiresAt || this.snapshot.leaseExpiresAt < Date.now()) {
			throw new Error("Lease expired");
		}
	}

	private async persist(): Promise<void> {
		await this.ctx.storage.put(SNAPSHOT_KEY, this.snapshot);
	}
}
