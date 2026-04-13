import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	acquireLease,
	releaseLease,
	advanceCursor,
	getCoordinatorState,
	getCoordinatorStub,
	getBrowserManagerStub,
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
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ acquired: true, leaseToken: "token-123", expiresAt: 12345 }), {
						status: 200,
					})
				),
				id: { name: "source-1" },
			} as unknown as DurableObjectStub;

			const result = await acquireLease(mockStub, {
				requestedBy: "test",
				ttlSeconds: 60,
			});

			expect(result.acquired).toBe(true);
			expect(result.leaseToken).toBe("token-123");
		});

		it("throws on failure response", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(new Response("Lease conflict", { status: 409 })),
				id: { name: "source-1" },
			} as unknown as DurableObjectStub;

			await expect(
				acquireLease(mockStub, { requestedBy: "test", ttlSeconds: 60 })
			).rejects.toThrow("Lease conflict");
		});

		it("includes sourceId in request body", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ acquired: true, leaseToken: "token-123" }), { status: 200 })
				),
				name: "source-1",
			} as unknown as DurableObjectStub;

			await acquireLease(mockStub, {
				requestedBy: "test",
				ttlSeconds: 60,
				sourceId: "explicit-source",
			});

			const body = JSON.parse((mockStub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
			expect(body.sourceId).toBe("explicit-source");
		});

		it("includes force flag in request body", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ acquired: true, leaseToken: "token-123" }), { status: 200 })
				),
				id: { name: "source-1" },
			} as unknown as DurableObjectStub;

			await acquireLease(mockStub, {
				requestedBy: "test",
				ttlSeconds: 60,
				force: true,
			});

			const body = JSON.parse((mockStub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
			expect(body.force).toBe(true);
		});
	});

	describe("releaseLease", () => {
		it("returns true on success", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ released: true }), { status: 200 })
				),
			} as unknown as DurableObjectStub;

			const result = await releaseLease(mockStub, "token-123");
			expect(result).toBe(true);
		});

		it("throws on failure response", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(new Response("Invalid token", { status: 400 })),
			} as unknown as DurableObjectStub;

			await expect(releaseLease(mockStub, "token-123")).rejects.toThrow("Invalid token");
		});

		it("returns false when released is not true", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ released: false }), { status: 200 })
				),
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
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify(mockSnapshot), { status: 200 })
				),
			} as unknown as DurableObjectStub;

			const result = await advanceCursor(mockStub, {
				leaseToken: "token-123",
				cursor: "cursor-2",
			});

			expect(result.cursor).toBe("cursor-2");
		});

		it("throws on failure response", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(new Response("Lease expired", { status: 409 })),
			} as unknown as DurableObjectStub;

			await expect(
				advanceCursor(mockStub, { leaseToken: "token-123", cursor: "cursor-2" })
			).rejects.toThrow("Lease expired");
		});

		it("includes failure count in request body", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ cursor: "cursor-2" }), { status: 200 })
				),
			} as unknown as DurableObjectStub;

			await advanceCursor(mockStub, {
				leaseToken: "token-123",
				cursor: "cursor-2",
				consecutiveFailures: 2,
			});

			const body = JSON.parse((mockStub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
			expect(body.consecutiveFailures).toBe(2);
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
				fetch: vi.fn().mockResolvedValue(
					new Response(JSON.stringify(mockState), { status: 200 })
				),
			} as unknown as DurableObjectStub;

			const result = await getCoordinatorState(mockStub);
			expect(result.sourceId).toBe("source-1");
		});

		it("throws on failure response", async () => {
			const mockStub = {
				fetch: vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })),
			} as unknown as DurableObjectStub;

			await expect(getCoordinatorState(mockStub)).rejects.toThrow("404");
		});
	});
});
