/**
 * Source Coordinator Integration Tests
 *
 * Tests lease acquire/release
 * Tests concurrent lease attempts
 * Tests cursor advancement
 * Tests success/failure recording
 */

import { describe, expect, it } from "vitest";
import {
	getCoordinatorStub,
	acquireLease,
	releaseLease,
	advanceCursor,
	recordCoordinatorSuccess,
	recordCoordinatorFailure,
	getCoordinatorState,
} from "../../lib/coordinator-client";
import type { Env } from "../../types";

function getTestSourceId(): string {
	return `test-source-${crypto.randomUUID()}`;
}

describe("source coordinator", () => {
	describe("lease management", () => {
		it("should acquire lease when none exists", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			const result = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});

			expect(result.acquired).toBe(true);
			expect(result.leaseToken).toBeDefined();
			expect(result.expiresAt).toBeDefined();
			expect(result.expiresAt).toBeGreaterThan(Date.now());
		});

		it("should reject second lease when active lease exists", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			// First lease
			const lease1 = await acquireLease(stub, {
				requestedBy: "test-runner-1",
				ttlSeconds: 60,
			});
			expect(lease1.acquired).toBe(true);

			// Second lease attempt should fail
			const lease2 = await acquireLease(stub, {
				requestedBy: "test-runner-2",
				ttlSeconds: 60,
			});

			expect(lease2.acquired).toBe(false);
			expect(lease2.reason).toContain("already active");
			expect(lease2.expiresAt).toBe(lease1.expiresAt);
		});

		it("should allow force acquisition of active lease", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			// First lease
			const lease1 = await acquireLease(stub, {
				requestedBy: "test-runner-1",
				ttlSeconds: 60,
			});
			expect(lease1.acquired).toBe(true);

			// Force acquire should succeed
			const lease2 = await acquireLease(stub, {
				requestedBy: "test-runner-2",
				ttlSeconds: 60,
				force: true,
			});

			expect(lease2.acquired).toBe(true);
			expect(lease2.leaseToken).not.toBe(lease1.leaseToken);
		});

		it("should release lease with valid token", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			const lease = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});
			expect(lease.acquired).toBe(true);

			const released = await releaseLease(stub, lease.leaseToken!);
			expect(released).toBe(true);

			// Should be able to acquire new lease after release
			const newLease = await acquireLease(stub, {
				requestedBy: "test-runner-2",
				ttlSeconds: 60,
			});
			expect(newLease.acquired).toBe(true);
		});

		it("should reject release with invalid token", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});

			const released = await releaseLease(stub, "invalid-token");
			expect(released).toBe(false);
		});
	});

	describe("concurrent lease attempts", () => {
		it("should handle concurrent lease requests deterministically", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			// Simulate concurrent lease requests
			const requests = Array.from({ length: 5 }, (_, i) =>
				acquireLease(stub, {
					requestedBy: `concurrent-runner-${i}`,
					ttlSeconds: 60,
				}),
			);

			const results = await Promise.all(requests);

			// Exactly one should succeed
			const acquired = results.filter((r) => r.acquired);
			expect(acquired.length).toBe(1);

			// All failures should have the same reason
			const failures = results.filter((r) => !r.acquired);
			for (const failure of failures) {
				expect(failure.reason).toContain("already active");
				expect(failure.expiresAt).toBe(acquired[0].expiresAt);
			}
		});
	});

	describe("cursor advancement", () => {
		it("should advance cursor with valid lease", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			const lease = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});

			const snapshot = await advanceCursor(stub, {
				leaseToken: lease.leaseToken!,
				cursor: "cursor-page-2",
				runId: "test-run-123",
			});

			expect(snapshot.cursor).toBe("cursor-page-2");
			expect(snapshot.lastRunId).toBe("test-run-123");
		});

		it("should reject cursor advancement with invalid lease", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			await expect(
				advanceCursor(stub, {
					leaseToken: "invalid-token",
					cursor: "cursor-page-2",
				}),
			).rejects.toThrow("Invalid lease token");
		});

		it("should reject cursor advancement after lease expires", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			// Acquire lease with very short TTL
			const lease = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 1, // 1 second TTL
			});

			// Wait for lease to expire
			await new Promise((resolve) => setTimeout(resolve, 1100));

			// Try to advance with expired lease
			await expect(
				advanceCursor(stub, {
					leaseToken: lease.leaseToken!,
					cursor: "cursor-page-2",
				}),
			).rejects.toThrow("Lease expired");
		});
	});

	describe("success/failure recording", () => {
		it("should record success and clear lease", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			const lease = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});

			const snapshot = await recordCoordinatorSuccess(stub, {
				leaseToken: lease.leaseToken!,
				runId: "test-run-success",
				cursor: "next-cursor-123",
			});

			expect(snapshot.lastRunId).toBe("test-run-success");
			expect(snapshot.cursor).toBe("next-cursor-123");
			expect(snapshot.consecutiveFailures).toBe(0);
			expect(snapshot.lastSuccessAt).toBeDefined();
			expect(snapshot.leaseToken).toBeUndefined();
			expect(snapshot.leaseOwner).toBeUndefined();
		});

		it("should record failure and increment counter", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			const lease = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});

			const snapshot = await recordCoordinatorFailure(stub, {
				leaseToken: lease.leaseToken!,
				runId: "test-run-failure",
				errorMessage: "Collection failed: timeout",
			});

			expect(snapshot.lastRunId).toBe("test-run-failure");
			expect(snapshot.consecutiveFailures).toBe(1);
			expect(snapshot.lastErrorAt).toBeDefined();
			expect(snapshot.lastErrorMessage).toBe("Collection failed: timeout");
			expect(snapshot.leaseToken).toBeUndefined();
		});

		it("should track consecutive failures", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			// First failure
			const lease1 = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});
			await recordCoordinatorFailure(stub, {
				leaseToken: lease1.leaseToken!,
				runId: "run-1",
				errorMessage: "Error 1",
			});

			// Second failure
			const lease2 = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});
			await recordCoordinatorFailure(stub, {
				leaseToken: lease2.leaseToken!,
				runId: "run-2",
				errorMessage: "Error 2",
			});

			// Third failure
			const lease3 = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});
			const snapshot = await recordCoordinatorFailure(stub, {
				leaseToken: lease3.leaseToken!,
				runId: "run-3",
				errorMessage: "Error 3",
			});

			expect(snapshot.consecutiveFailures).toBe(3);
		});

		it("should reset consecutive failures on success", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();
			const stub = getCoordinatorStub(testEnv, sourceId);

			// First failure
			const lease1 = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});
			await recordCoordinatorFailure(stub, {
				leaseToken: lease1.leaseToken!,
				runId: "run-1",
				errorMessage: "Error 1",
			});

			// Success should reset counter
			const lease2 = await acquireLease(stub, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});
			const snapshot = await recordCoordinatorSuccess(stub, {
				leaseToken: lease2.leaseToken!,
				runId: "run-2",
			});

			expect(snapshot.consecutiveFailures).toBe(0);
		});
	});

	describe("state persistence", () => {
		it("should persist state across stub recreations", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = getTestSourceId();

			// First stub
			const stub1 = getCoordinatorStub(testEnv, sourceId);
			const lease = await acquireLease(stub1, {
				requestedBy: "test-runner",
				ttlSeconds: 60,
			});
			await advanceCursor(stub1, {
				leaseToken: lease.leaseToken!,
				cursor: "persisted-cursor",
				runId: "persisted-run",
			});

			// New stub for same source (simulates restart)
			const stub2 = getCoordinatorStub(testEnv, sourceId);
			const state = await getCoordinatorState(stub2);

			expect(state.cursor).toBe("persisted-cursor");
			expect(state.lastRunId).toBe("persisted-run");
		});
	});
});
