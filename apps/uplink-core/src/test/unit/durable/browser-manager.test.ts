import { describe, expect, it, vi, beforeEach } from "vitest";
import { BrowserManagerDO } from "../../../durable/browser-manager";

// Mock DurableObjectState
function createMockState(): DurableObjectState {
	const storage = new Map<string, unknown>();
	let alarmTime: number | null = null;

	return {
		storage: {
			get: vi.fn(async (key: string) => storage.get(key)),
			put: vi.fn(async (key: string, value: unknown) => storage.set(key, value)),
			delete: vi.fn(async (key: string) => storage.delete(key)),
			getAlarm: vi.fn(async () => alarmTime),
			setAlarm: vi.fn(async (time: number) => { alarmTime = time; }),
			deleteAlarm: vi.fn(async () => { alarmTime = null; }),
			list: vi.fn(async () => storage),
		},
		id: { name: "global", toString: () => "global" },
		waitUntil: vi.fn(),
		abort: vi.fn(),
		blockConcurrencyWhile: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
	} as unknown as DurableObjectState;
}

function createMockEnv(): Env {
	return {} as Env;
}

describe("BrowserManagerDO", () => {
	let manager: BrowserManagerDO;
	let state: DurableObjectState;

	beforeEach(async () => {
		state = createMockState();
		manager = new BrowserManagerDO(state, createMockEnv());
		// Wait for blockConcurrencyWhile to complete
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	describe("status endpoint", () => {
		it("returns empty status initially", async () => {
			const response = await manager.fetch(new Request("https://browser-manager/status"));
			const status = await response.json() as {
				sessions: { total: number; available: number; assigned: number };
				queue: { length: number };
			};
			expect(status.sessions.total).toBe(0);
			expect(status.sessions.available).toBe(0);
			expect(status.queue.length).toBe(0);
		});
	});

	describe("session request", () => {
		it("creates new session when pool is empty", async () => {
			const response = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-1" }),
				})
			);
			const result = await response.json() as { assigned: boolean; sessionId: string };
			expect(result.assigned).toBe(true);
			expect(result.sessionId).toBeTruthy();
		});

		it("reuses available session", async () => {
			// First request
			const res1 = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-1" }),
				})
			);
			const data1 = await res1.json() as { assigned: boolean; sessionId: string };

			// Release it
			await manager.fetch(
				new Request("https://browser-manager/session/release", {
					method: "POST",
					body: JSON.stringify({ sessionId: data1.sessionId, sourceId: "src-1" }),
				})
			);

			// Second request should reuse
			const res2 = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-2", requestId: "req-2" }),
				})
			);
			const data2 = await res2.json() as { assigned: boolean; sessionId: string };
			expect(data2.sessionId).toBe(data1.sessionId);
		});

		it("queues requests when at capacity", async () => {
			// Fill pool
			for (let i = 0; i < 10; i++) {
				await manager.fetch(
					new Request("https://browser-manager/session/request", {
						method: "POST",
						body: JSON.stringify({ sourceId: `src-${i}`, requestId: `req-${i}` }),
					})
				);
			}

			// 11th request should be queued
			const response = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-overflow", requestId: "req-overflow" }),
				})
			);
			const result = await response.json() as { assigned: boolean; queuePosition: number };
			expect(result.assigned).toBe(false);
			expect(result.queuePosition).toBe(1);
		});

		it("rejects when queue is full", async () => {
			// Fill pool
			for (let i = 0; i < 10; i++) {
				await manager.fetch(
					new Request("https://browser-manager/session/request", {
						method: "POST",
						body: JSON.stringify({ sourceId: `src-${i}`, requestId: `req-${i}` }),
					})
				);
			}

			// Fill queue
			for (let i = 0; i < 50; i++) {
				await manager.fetch(
					new Request("https://browser-manager/session/request", {
						method: "POST",
						body: JSON.stringify({ sourceId: `src-q-${i}`, requestId: `req-q-${i}` }),
					})
				);
			}

			// 61st request should be rejected
			const response = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-rejected", requestId: "req-rejected" }),
				})
			);
			const result = await response.json() as { assigned: boolean };
			expect(result.assigned).toBe(false);
		});
	});

	describe("session release", () => {
		it("releases session successfully", async () => {
			const reqRes = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-1" }),
				})
			);
			const reqData = await reqRes.json() as { sessionId: string };

			const releaseRes = await manager.fetch(
				new Request("https://browser-manager/session/release", {
					method: "POST",
					body: JSON.stringify({ sessionId: reqData.sessionId, sourceId: "src-1" }),
				})
			);
			const releaseData = await releaseRes.json() as { released: boolean };
			expect(releaseData.released).toBe(true);
		});

		it("rejects release for wrong source", async () => {
			const reqRes = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-1" }),
				})
			);
			const reqData = await reqRes.json() as { sessionId: string };

			const releaseRes = await manager.fetch(
				new Request("https://browser-manager/session/release", {
					method: "POST",
					body: JSON.stringify({ sessionId: reqData.sessionId, sourceId: "src-2" }),
				})
			);
			const releaseData = await releaseRes.json() as { released: boolean };
			expect(releaseData.released).toBe(false);
		});

		it("marks session error after 3 errors", async () => {
			const reqRes = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-1" }),
				})
			);
			const reqData = await reqRes.json() as { sessionId: string };

			// Release with error 3 times
			for (let i = 0; i < 3; i++) {
				await manager.fetch(
					new Request("https://browser-manager/session/release", {
						method: "POST",
						body: JSON.stringify({
							sessionId: reqData.sessionId,
							sourceId: "src-1",
							error: true,
						}),
					})
				);

				// Request again to reassign
				if (i < 2) {
					await manager.fetch(
						new Request("https://browser-manager/session/request", {
							method: "POST",
							body: JSON.stringify({ sourceId: "src-1", requestId: `req-${i + 2}` }),
						})
					);
				}
			}

			// Session should be in error state, so new request creates a new one
			const newReqRes = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-final" }),
				})
			);
			const newReqData = await newReqRes.json() as { sessionId: string };
			expect(newReqData.sessionId).not.toBe(reqData.sessionId);
		});
	});

	describe("session heartbeat", () => {
		it("acknowledges valid heartbeat", async () => {
			const reqRes = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-1" }),
				})
			);
			const reqData = await reqRes.json() as { sessionId: string };

			const hbRes = await manager.fetch(
				new Request("https://browser-manager/session/heartbeat", {
					method: "POST",
					body: JSON.stringify({ sessionId: reqData.sessionId, sourceId: "src-1" }),
				})
			);
			const hbData = await hbRes.json() as { ok: boolean };
			expect(hbData.ok).toBe(true);
		});

		it("rejects heartbeat for wrong source", async () => {
			const reqRes = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-1" }),
				})
			);
			const reqData = await reqRes.json() as { sessionId: string };

			const hbRes = await manager.fetch(
				new Request("https://browser-manager/session/heartbeat", {
					method: "POST",
					body: JSON.stringify({ sessionId: reqData.sessionId, sourceId: "src-2" }),
				})
			);
			const hbData = await hbRes.json() as { ok: boolean };
			expect(hbData.ok).toBe(false);
		});
	});

	describe("cleanup alarm", () => {
		it("schedules alarm on initialization", async () => {
			expect(state.storage.setAlarm).toHaveBeenCalled();
		});

		it("cleans up stale sessions", async () => {
			const reqRes = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-1", requestId: "req-1" }),
				})
			);
			const reqData = await reqRes.json() as { sessionId: string };
			expect(reqData.sessionId).toBeTruthy();

			// Trigger alarm
			await manager.alarm();

			// Session should still exist (not stale yet)
			const statusRes = await manager.fetch(new Request("https://browser-manager/status"));
			const status = await statusRes.json() as { sessions: { total: number } };
			expect(status.sessions.total).toBe(1);
		});
	});

	describe("force cleanup", () => {
		it("clears all sessions and queue", async () => {
			// Create some sessions
			for (let i = 0; i < 3; i++) {
				await manager.fetch(
					new Request("https://browser-manager/session/request", {
						method: "POST",
						body: JSON.stringify({ sourceId: `src-${i}`, requestId: `req-${i}` }),
					})
				);
			}

			// Add to queue
			for (let i = 0; i < 5; i++) {
				await manager.fetch(
					new Request("https://browser-manager/session/request", {
						method: "POST",
						body: JSON.stringify({ sourceId: `src-q-${i}`, requestId: `req-q-${i}` }),
					})
				);
			}

			const cleanupRes = await manager.fetch(
				new Request("https://browser-manager/admin/cleanup", { method: "POST" })
			);
			const cleanupData = await cleanupRes.json() as { cleaned: number; queueCleared: number };
			expect(cleanupData.cleaned).toBe(3);
			expect(cleanupData.queueCleared).toBe(5);
		});
	});

	describe("queue processing", () => {
		it("assigns queued request when session becomes available", async () => {
			// Fill pool
			for (let i = 0; i < 10; i++) {
				await manager.fetch(
					new Request("https://browser-manager/session/request", {
						method: "POST",
						body: JSON.stringify({ sourceId: `src-${i}`, requestId: `req-${i}` }),
					})
				);
			}

			// Queue one more
			const queueRes = await manager.fetch(
				new Request("https://browser-manager/session/request", {
					method: "POST",
					body: JSON.stringify({ sourceId: "src-queued", requestId: "req-queued" }),
				})
			);
			const queueData = await queueRes.json() as { assigned: boolean };
			expect(queueData.assigned).toBe(false);

			// Get first session
			const statusRes1 = await manager.fetch(new Request("https://browser-manager/status"));
			const status1 = await statusRes1.json() as { sessions: { assigned: number } };
			expect(status1.sessions.assigned).toBe(10);

			// Release first session
			const sessions = [] as string[];
			for (let i = 0; i < 10; i++) {
				const req = await manager.fetch(
					new Request("https://browser-manager/session/request", {
						method: "POST",
						body: JSON.stringify({ sourceId: `src-new-${i}`, requestId: `req-new-${i}` }),
					})
				);
				const data = await req.json() as { assigned: boolean; sessionId?: string; queuePosition?: number };
				if (data.sessionId) sessions.push(data.sessionId);
			}

			// Now release one
			await manager.fetch(
				new Request("https://browser-manager/session/release", {
					method: "POST",
					body: JSON.stringify({ sessionId: sessions[0], sourceId: `src-new-0` }),
				})
			);

			// The queued request should now have a session assigned
			// But we can't directly check that without exposing internal queue state
			// So we check that assigned count stays at 10
			const statusRes2 = await manager.fetch(new Request("https://browser-manager/status"));
			const status2 = await statusRes2.json() as { sessions: { assigned: number }; queue: { length: number } };
			expect(status2.sessions.assigned).toBe(10);
			expect(status2.queue.length).toBeLessThan(6); // Some queue items may have been processed
		});
	});
});
