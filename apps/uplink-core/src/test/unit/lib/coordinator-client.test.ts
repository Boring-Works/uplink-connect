import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	acquireLease,
	releaseLease,
	advanceCursor,
	getCoordinatorState,
	getCoordinatorStub,
	getBrowserManagerStub,
	requestBrowserSession,
	releaseBrowserSession,
	heartbeatBrowserSession,
	getBrowserManagerStatus,
	forceBrowserManagerCleanup,
} from "../../../lib/coordinator-client";

describe("coordinator-client", () => {
	describe("getCoordinatorStub", () => {
		it("returns stub from DO namespace", () => {
			const mockStub = {} as DurableObjectStub;
			const mockEnv = {
				SOURCE_COORDINATOR: {
					getByName: vi.fn().mockReturnValue(mockStub),
				},
			} as unknown as Parameters<typeof getCoordinatorStub>[0];

			const result = getCoordinatorStub(mockEnv, "source-1");
			expect(result).toBe(mockStub);
			expect((mockEnv.SOURCE_COORDINATOR.getByName as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("source-1");
		});

		it("throws when SOURCE_COORDINATOR is not configured", () => {
			const mockEnv = {} as unknown as Parameters<typeof getCoordinatorStub>[0];
			expect(() => getCoordinatorStub(mockEnv, "source-1")).toThrow();
		});
	});

	describe("getBrowserManagerStub", () => {
		it("returns stub from DO namespace", () => {
			const mockStub = {} as DurableObjectStub;
			const mockEnv = {
				BROWSER_MANAGER: {
					getByName: vi.fn().mockReturnValue(mockStub),
				},
			} as unknown as Parameters<typeof getBrowserManagerStub>[0];

			const result = getBrowserManagerStub(mockEnv);
			expect(result).toBe(mockStub);
			expect((mockEnv.BROWSER_MANAGER.getByName as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("global");
		});

		it("throws when BROWSER_MANAGER is not configured", () => {
			const mockEnv = {} as unknown as Parameters<typeof getBrowserManagerStub>[0];
			expect(() => getBrowserManagerStub(mockEnv)).toThrow();
		});
	});

	describe("acquireLease", () => {
		it("returns lease on success", async () => {
			const mockStub = {
				acquireLease: vi.fn().mockResolvedValue({ acquired: true, leaseToken: "token-123", expiresAt: 12345 }),
				id: { name: "source-1" },
			} as unknown as DurableObjectStub;

			const result = await acquireLease(mockStub, {
				requestedBy: "test",
				ttlSeconds: 60,
			});

			expect(result.acquired).toBe(true);
			expect(result.leaseToken).toBe("token-123");
		});

		it("propagates errors from RPC", async () => {
			const mockStub = {
				acquireLease: vi.fn().mockRejectedValue(new Error("Lease conflict")),
				id: { name: "source-1" },
			} as unknown as DurableObjectStub;

			await expect(
				acquireLease(mockStub, { requestedBy: "test", ttlSeconds: 60 })
			).rejects.toThrow("Lease conflict");
		});

		it("includes sourceId in RPC params", async () => {
			const mockStub = {
				acquireLease: vi.fn().mockResolvedValue({ acquired: true, leaseToken: "token-123" }),
				name: "source-1",
			} as unknown as DurableObjectStub;

			await acquireLease(mockStub, {
				requestedBy: "test",
				ttlSeconds: 60,
				sourceId: "explicit-source",
			});

			expect((mockStub.acquireLease as ReturnType<typeof vi.fn>).mock.calls[0][0].sourceId).toBe("explicit-source");
		});

		it("includes force flag in RPC params", async () => {
			const mockStub = {
				acquireLease: vi.fn().mockResolvedValue({ acquired: true, leaseToken: "token-123" }),
				id: { name: "source-1" },
			} as unknown as DurableObjectStub;

			await acquireLease(mockStub, {
				requestedBy: "test",
				ttlSeconds: 60,
				force: true,
			});

			expect((mockStub.acquireLease as ReturnType<typeof vi.fn>).mock.calls[0][0].force).toBe(true);
		});
	});

	describe("releaseLease", () => {
		it("returns true on success", async () => {
			const mockStub = {
				releaseLease: vi.fn().mockResolvedValue({ released: true }),
			} as unknown as DurableObjectStub;

			const result = await releaseLease(mockStub, "token-123");
			expect(result).toBe(true);
		});

		it("propagates errors from RPC", async () => {
			const mockStub = {
				releaseLease: vi.fn().mockRejectedValue(new Error("Invalid token")),
			} as unknown as DurableObjectStub;

			await expect(releaseLease(mockStub, "token-123")).rejects.toThrow("Invalid token");
		});

		it("returns false when released is not true", async () => {
			const mockStub = {
				releaseLease: vi.fn().mockResolvedValue({ released: false }),
			} as unknown as DurableObjectStub;

			const result = await releaseLease(mockStub, "token-123");
			expect(result).toBe(false);
		});
	});

	describe("advanceCursor", () => {
		it("returns snapshot on success", async () => {
			const mockSnapshot = {
				sourceId: "source-1",
				cursor: "cursor-2",
				consecutiveFailures: 0,
				updatedAt: Date.now(),
			};
			const mockStub = {
				advanceCursor: vi.fn().mockResolvedValue(mockSnapshot),
			} as unknown as DurableObjectStub;

			const result = await advanceCursor(mockStub, {
				leaseToken: "token-123",
				cursor: "cursor-2",
			});

			expect(result.cursor).toBe("cursor-2");
		});

		it("propagates errors from RPC", async () => {
			const mockStub = {
				advanceCursor: vi.fn().mockRejectedValue(new Error("Lease expired")),
			} as unknown as DurableObjectStub;

			await expect(
				advanceCursor(mockStub, { leaseToken: "token-123", cursor: "cursor-2" })
			).rejects.toThrow("Lease expired");
		});
	});

	describe("getCoordinatorState", () => {
		it("returns state on success", async () => {
			const mockState = {
				sourceId: "source-1",
				consecutiveFailures: 0,
				updatedAt: Date.now(),
			};
			const mockStub = {
				getState: vi.fn().mockResolvedValue(mockState),
			} as unknown as DurableObjectStub;

			const result = await getCoordinatorState(mockStub);
			expect(result.sourceId).toBe("source-1");
		});

		it("propagates errors from RPC", async () => {
			const mockStub = {
				getState: vi.fn().mockRejectedValue(new Error("Not found")),
			} as unknown as DurableObjectStub;

			await expect(getCoordinatorState(mockStub)).rejects.toThrow("Not found");
		});
	});

	describe("BrowserManager RPC wrappers", () => {
		it("requestBrowserSession calls requestSessionRpc", async () => {
			const mockStub = {
				requestSessionRpc: vi.fn().mockResolvedValue({ assigned: true, sessionId: "sess-1" }),
			} as unknown as DurableObjectStub;

			const result = await requestBrowserSession(mockStub, { sourceId: "src-1", requestId: "req-1" });
			expect(result.assigned).toBe(true);
			expect(result.sessionId).toBe("sess-1");
			expect((mockStub.requestSessionRpc as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
				sourceId: "src-1",
				requestId: "req-1",
			});
		});

		it("releaseBrowserSession calls releaseSessionRpc", async () => {
			const mockStub = {
				releaseSessionRpc: vi.fn().mockResolvedValue({ released: true }),
			} as unknown as DurableObjectStub;

			const result = await releaseBrowserSession(mockStub, { sessionId: "sess-1", sourceId: "src-1" });
			expect(result.released).toBe(true);
		});

		it("heartbeatBrowserSession calls heartbeatRpc", async () => {
			const mockStub = {
				heartbeatRpc: vi.fn().mockResolvedValue({ ok: true }),
			} as unknown as DurableObjectStub;

			const result = await heartbeatBrowserSession(mockStub, { sessionId: "sess-1", sourceId: "src-1" });
			expect(result.ok).toBe(true);
		});

		it("getBrowserManagerStatus calls getStatusRpc", async () => {
			const mockStub = {
				getStatusRpc: vi.fn().mockResolvedValue({ sessions: { total: 5 } }),
			} as unknown as DurableObjectStub;

			const result = await getBrowserManagerStatus(mockStub);
			expect(result).toEqual({ sessions: { total: 5 } });
		});

		it("forceBrowserManagerCleanup calls forceCleanupRpc", async () => {
			const mockStub = {
				forceCleanupRpc: vi.fn().mockResolvedValue({ cleaned: 3 }),
			} as unknown as DurableObjectStub;

			const result = await forceBrowserManagerCleanup(mockStub);
			expect(result.cleaned).toBe(3);
		});
	});
});
