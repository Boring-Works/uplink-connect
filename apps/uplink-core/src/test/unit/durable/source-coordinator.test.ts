import { describe, expect, it, vi, beforeEach } from "vitest";
import { SourceCoordinator, BACKPRESSURE_CONFIG } from "../../../durable/source-coordinator";

function createMockState(sourceId = "source-1"): DurableObjectState {
	const storage = new Map<string, unknown>();
	return {
		storage: {
			get: vi.fn(async (key: string) => storage.get(key)),
			put: vi.fn(async (key: string, value: unknown) => storage.set(key, value)),
			delete: vi.fn(async (key: string) => storage.delete(key)),
			getAlarm: vi.fn(async () => null),
			setAlarm: vi.fn(),
			deleteAlarm: vi.fn(),
			list: vi.fn(async () => storage),
		},
		id: { name: sourceId, toString: () => sourceId } as DurableObjectId,
		waitUntil: vi.fn(),
		abort: vi.fn(),
		blockConcurrencyWhile: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
	} as unknown as DurableObjectState;
}

function createMockEnv(): Env {
	return {} as Env;
}

describe("SourceCoordinator", () => {
	let coordinator: SourceCoordinator;
	let state: DurableObjectState;

	beforeEach(async () => {
		state = createMockState();
		coordinator = new SourceCoordinator(state, createMockEnv());
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	describe("state endpoint", () => {
		it("returns initial state", async () => {
			const response = await coordinator.fetch(new Request("https://coordinator/state"));
			const data = await response.json() as { sourceId: string; consecutiveFailures: number };
			expect(data.sourceId).toBe("source-1");
			expect(data.consecutiveFailures).toBe(0);
		});
	});

	describe("health endpoint", () => {
		it("returns healthy for idle source", async () => {
			const response = await coordinator.fetch(new Request("https://coordinator/health"));
			const data = await response.json() as { status: string; healthy: boolean };
			expect(data.status).toBe("idle");
			expect(data.healthy).toBe(true);
		});
	});

	describe("lease acquisition", () => {
		it("grants lease when idle", async () => {
			const response = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);
			const data = await response.json() as { acquired: boolean; leaseToken?: string };
			expect(data.acquired).toBe(true);
			expect(data.leaseToken).toBeTruthy();
		});

		it("denies lease when already active", async () => {
			await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);

			const response = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "other", ttlSeconds: 60 }),
				})
			);
			const data = await response.json() as { acquired: boolean; reason?: string };
			expect(data.acquired).toBe(false);
			expect(data.reason).toContain("Lease already active");
		});

		it("allows force acquisition", async () => {
			await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);

			const response = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "other", ttlSeconds: 60, force: true }),
				})
			);
			const data = await response.json() as { acquired: boolean };
			expect(data.acquired).toBe(true);
		});

		it("denies lease when source is paused", async () => {
			// Simulate failures to trigger auto-pause
			for (let i = 0; i < BACKPRESSURE_CONFIG.maxConsecutiveFailures; i++) {
				await coordinator.fetch(
					new Request("https://coordinator/state/failure", {
						method: "POST",
						body: JSON.stringify({ leaseToken: "", errorMessage: "fail" }),
					})
				);
			}

			const response = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);
			const data = await response.json() as { acquired: boolean; reason?: string };
			expect(data.acquired).toBe(false);
			expect(data.reason).toContain("paused");
		});

		it("allows force acquisition when paused", async () => {
			// Trigger auto-pause
			for (let i = 0; i < BACKPRESSURE_CONFIG.maxConsecutiveFailures; i++) {
				await coordinator.fetch(
					new Request("https://coordinator/state/failure", {
						method: "POST",
						body: JSON.stringify({ leaseToken: "", errorMessage: "fail" }),
					})
				);
			}

			const response = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60, force: true }),
				})
			);
			const data = await response.json() as { acquired: boolean };
			expect(data.acquired).toBe(true);
		});

		it("rate limits rapid acquisitions", async () => {
			await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);

			// Immediately try again
			const response = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);
			const data = await response.json() as { acquired: boolean; reason?: string };
			expect(data.acquired).toBe(false);
			expect(data.reason).toContain("Rate limited");
		});

		it("enforces max records per run limit", async () => {
			const response = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({
						requestedBy: "test",
						ttlSeconds: 60,
						estimatedRecords: BACKPRESSURE_CONFIG.maxRecordsPerRun + 1,
					}),
				})
			);
			const data = await response.json() as { acquired: boolean; reason?: string };
			expect(data.acquired).toBe(false);
			expect(data.reason).toContain("Too many records");
		});
	});

	describe("lease release", () => {
		it("releases active lease", async () => {
			const acquireRes = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);
			const acquireData = await acquireRes.json() as { leaseToken: string };

			const releaseRes = await coordinator.fetch(
				new Request("https://coordinator/lease/release", {
					method: "POST",
					body: JSON.stringify({ leaseToken: acquireData.leaseToken }),
				})
			);
			const releaseData = await releaseRes.json() as { released: boolean };
			expect(releaseData.released).toBe(true);
		});

		it("returns false for invalid token", async () => {
			const response = await coordinator.fetch(
				new Request("https://coordinator/lease/release", {
					method: "POST",
					body: JSON.stringify({ leaseToken: "wrong-token" }),
				})
			);
			const data = await response.json() as { released: boolean };
			expect(data.released).toBe(false);
		});
	});

	describe("cursor advancement", () => {
		it("advances cursor with valid lease", async () => {
			const acquireRes = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);
			const acquireData = await acquireRes.json() as { leaseToken: string };

			const response = await coordinator.fetch(
				new Request("https://coordinator/cursor/advance", {
					method: "POST",
					body: JSON.stringify({
						leaseToken: acquireData.leaseToken,
						cursor: "cursor-2",
						runId: "run-1",
					}),
				})
			);
			const data = await response.json() as { cursor: string; lastRunId: string };
			expect(data.cursor).toBe("cursor-2");
			expect(data.lastRunId).toBe("run-1");
		});

		it("rejects cursor advance with invalid lease", async () => {
			const response = await coordinator.fetch(
				new Request("https://coordinator/cursor/advance", {
					method: "POST",
					body: JSON.stringify({ leaseToken: "wrong-token", cursor: "cursor-2" }),
				})
			);
			expect(response.status).toBe(409);
		});
	});

	describe("success recording", () => {
		it("records success and resets failures", async () => {
			const acquireRes = await coordinator.fetch(
				new Request("https://coordinator/lease/acquire", {
					method: "POST",
					body: JSON.stringify({ requestedBy: "test", ttlSeconds: 60 }),
				})
			);
			const acquireData = await acquireRes.json() as { leaseToken: string };

			const response = await coordinator.fetch(
				new Request("https://coordinator/state/success", {
					method: "POST",
					body: JSON.stringify({
						leaseToken: acquireData.leaseToken,
						runId: "run-1",
						cursor: "cursor-2",
					}),
				})
			);
			const data = await response.json() as { consecutiveFailures: number; lastSuccessAt?: string };
			expect(data.consecutiveFailures).toBe(0);
			expect(data.lastSuccessAt).toBeTruthy();
		});
	});

	describe("failure recording", () => {
		it("increments consecutive failures", async () => {
			const response = await coordinator.fetch(
				new Request("https://coordinator/state/failure", {
					method: "POST",
					body: JSON.stringify({ leaseToken: "", errorMessage: "Something failed" }),
				})
			);
			const data = await response.json() as { consecutiveFailures: number; lastErrorMessage?: string };
			expect(data.consecutiveFailures).toBe(1);
			expect(data.lastErrorMessage).toBe("Something failed");
		});

		it("auto-pauses after max consecutive failures", async () => {
			for (let i = 0; i < BACKPRESSURE_CONFIG.maxConsecutiveFailures; i++) {
				await coordinator.fetch(
					new Request("https://coordinator/state/failure", {
						method: "POST",
						body: JSON.stringify({ leaseToken: "", errorMessage: `fail ${i}` }),
					})
				);
			}

			const healthRes = await coordinator.fetch(new Request("https://coordinator/health"));
			const healthData = await healthRes.json() as { status: string; healthy: boolean };
			expect(healthData.status).toBe("paused");
			expect(healthData.healthy).toBe(false);
		});
	});

	describe("unpause", () => {
		it("unpauses a paused source", async () => {
			// Trigger auto-pause
			for (let i = 0; i < BACKPRESSURE_CONFIG.maxConsecutiveFailures; i++) {
				await coordinator.fetch(
					new Request("https://coordinator/state/failure", {
						method: "POST",
						body: JSON.stringify({ leaseToken: "", errorMessage: "fail" }),
					})
				);
			}

			const unpauseRes = await coordinator.fetch(
				new Request("https://coordinator/admin/unpause", { method: "POST" })
			);
			const unpauseData = await unpauseRes.json() as { unpaused: boolean };
			expect(unpauseData.unpaused).toBe(true);

			const healthRes = await coordinator.fetch(new Request("https://coordinator/health"));
			const healthData = await healthRes.json() as { status: string };
			expect(healthData.status).toBe("idle");
		});

		it("returns false when not paused", async () => {
			const response = await coordinator.fetch(
				new Request("https://coordinator/admin/unpause", { method: "POST" })
			);
			const data = await response.json() as { unpaused: boolean };
			expect(data.unpaused).toBe(false);
		});
	});

	describe("backpressure state persistence", () => {
		it("persists backpressure state on failure", async () => {
			await coordinator.fetch(
				new Request("https://coordinator/state/failure", {
					method: "POST",
					body: JSON.stringify({ leaseToken: "", errorMessage: "fail" }),
				})
			);

			expect(state.storage.put).toHaveBeenCalled();
		});
	});
});
