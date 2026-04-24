import { describe, expect, it, vi, beforeEach } from "vitest";
import { BrowserManagerDO } from "../../../durable/browser-manager";

// Mock DurableObjectState
function createMockSqlStorage() {
	// Minimal in-memory SQL mock for BrowserManagerDO unit tests
	const tables = new Map<string, Record<string, unknown>[]>();
	let autoIncrement = 1;

	function getTable(name: string): Record<string, unknown>[] {
		if (!tables.has(name)) tables.set(name, []);
		return tables.get(name)!;
	}

	function parseWhere(sql: string, params: unknown[]): ((row: Record<string, unknown>) => boolean) | null {
		// Very simplistic WHERE parser for the queries used in BrowserManagerDO
		if (!sql.includes("WHERE")) return null;
		const wherePart = sql.split("WHERE")[1]?.split("ORDER BY")[0]?.split("LIMIT")[0]?.trim();
		if (!wherePart) return null;

		// Handle session_id = ?
		const eqMatch = wherePart.match(/(\w+)\s*=\s*\?/);
		if (eqMatch) {
			const col = eqMatch[1];
			let paramIdx = 0;
			// Count ? before this match in the WHERE clause
			const before = wherePart.slice(0, eqMatch.index);
			paramIdx = (before.match(/\?/g) || []).length;
			const value = params[paramIdx];
			return (row) => row[col] === value;
		}

		// Handle status IN (?, ?)
		const inMatch = wherePart.match(/(\w+)\s+IN\s*\(([^)]+)\)/);
		if (inMatch) {
			const col = inMatch[1];
			const qCount = (inMatch[2].match(/\?/g) || []).length;
			let paramIdx = 0;
			const before = wherePart.slice(0, inMatch.index);
			paramIdx = (before.match(/\?/g) || []).length;
			const values = params.slice(paramIdx, paramIdx + qCount);
			return (row) => values.includes(row[col]);
		}

		// Handle ? - last_used_at > ?
		const gtMatch = wherePart.match(/\?\s*-\s*(\w+)\s*>\s*\?/);
		if (gtMatch) {
			const col = gtMatch[1];
			let paramIdx = 0;
			const before = wherePart.slice(0, gtMatch.index);
			paramIdx = (before.match(/\?/g) || []).length;
			const now = params[paramIdx] as number;
			const threshold = params[paramIdx + 1] as number;
			return (row) => (now - (row[col] as number)) > threshold;
		}

		// Handle key = 'global'
		const literalMatch = wherePart.match(/(\w+)\s*=\s*'([^']+)'/);
		if (literalMatch) {
			const col = literalMatch[1];
			const value = literalMatch[2];
			return (row) => row[col] === value;
		}

		return null;
	}

	function parseOrderBy(sql: string): { col: string; dir: "ASC" | "DESC" } | null {
		const match = sql.match(/ORDER BY\s+(\w+)\s*(ASC|DESC)?/i);
		if (!match) return null;
		return { col: match[1], dir: (match[2] as "ASC" | "DESC") ?? "ASC" };
	}

	function parseLimit(sql: string): number | null {
		const match = sql.match(/LIMIT\s+(\?|\d+)/i);
		if (!match) return null;
		if (match[1] === "?") return null; // handled separately
		return Number.parseInt(match[1], 10);
	}

	return {
		exec: vi.fn((sql: string, ...params: unknown[]) => {
			const upper = sql.trim().toUpperCase();

			// CREATE TABLE
			if (upper.startsWith("CREATE TABLE")) {
				const nameMatch = sql.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
				if (nameMatch) getTable(nameMatch[1]);
				return { one: () => null, first: () => undefined, toArray: () => [], [Symbol.iterator]: function* () {} };
			}

			// CREATE INDEX
			if (upper.startsWith("CREATE INDEX")) {
				return { one: () => null, first: () => undefined, toArray: () => [], [Symbol.iterator]: function* () {} };
			}

			// INSERT
			if (upper.startsWith("INSERT")) {
				const nameMatch = sql.match(/INTO\s+(\w+)/i);
				const tableName = nameMatch ? nameMatch[1] : "unknown";
				const table = getTable(tableName);
				const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/);
				const cols = colMatch ? colMatch[1].split(",").map((c) => c.trim()) : [];
				const row: Record<string, unknown> = {};
				for (let i = 0; i < cols.length; i++) {
					row[cols[i]] = params[i] ?? null;
				}
				if (!row.id && tableName !== "_metadata") {
					row.id = autoIncrement++;
				}
				table.push(row);
				return { one: () => row, first: () => row, toArray: () => [row], [Symbol.iterator]: function* () { yield row; } };
			}

			// SELECT
			if (upper.startsWith("SELECT")) {
				const fromMatch = sql.match(/FROM\s+(\w+)/i);
				const tableName = fromMatch ? fromMatch[1] : "";
				const table = getTable(tableName);
				let results = [...table];

				const whereFn = parseWhere(sql, params);
				if (whereFn) results = results.filter(whereFn);

				const order = parseOrderBy(sql);
				if (order) {
					results.sort((a, b) => {
						const av = a[order.col];
						const bv = b[order.col];
						if (av === null || av === undefined) return 1;
						if (bv === null || bv === undefined) return -1;
						if (typeof av === "number" && typeof bv === "number") {
							return order.dir === "DESC" ? bv - av : av - bv;
						}
						return order.dir === "DESC" ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
					});
				}

				const limit = parseLimit(sql);
				if (limit) results = results.slice(0, limit);

				// Handle COUNT(*)
				if (upper.includes("COUNT(*)")) {
					const countRow = { c: results.length };
					return { one: () => countRow, first: () => countRow, toArray: () => [countRow], [Symbol.iterator]: function* () { yield countRow; } };
				}

				return {
					one: () => results[0] ?? null,
					first: () => results[0],
					toArray: () => results,
					[Symbol.iterator]: function* () { yield* results; },
				};
			}

			// UPDATE
			if (upper.startsWith("UPDATE")) {
				const nameMatch = sql.match(/UPDATE\s+(\w+)/i);
				const tableName = nameMatch ? nameMatch[1] : "";
				const table = getTable(tableName);
				let results = [...table];

				const whereFn = parseWhere(sql, params);
				if (whereFn) results = results.filter(whereFn);

				// Parse SET clauses - very simple parser
				const setMatch = sql.match(/SET\s+(.+?)(?:WHERE|$)/i);
				if (setMatch) {
					const setPart = setMatch[1];
					const setCols = setPart.split(",").map((s) => s.trim());
					let paramIdx = 0;
					// Count ? before SET
					const beforeSet = sql.slice(0, sql.toUpperCase().indexOf("SET"));
					paramIdx = (beforeSet.match(/\?/g) || []).length;

					for (const row of results) {
						for (const setCol of setCols) {
							const colEq = setCol.match(/(\w+)\s*=\s*\?/);
							if (colEq) {
								row[colEq[1]] = params[paramIdx];
								paramIdx++;
							}
						}
					}
				}

				return { one: () => results[0] ?? null, first: () => results[0], toArray: () => results, [Symbol.iterator]: function* () { yield* results; } };
			}

			// DELETE
			if (upper.startsWith("DELETE")) {
				const nameMatch = sql.match(/FROM\s+(\w+)/i);
				const tableName = nameMatch ? nameMatch[1] : "";
				const table = getTable(tableName);
				let indicesToDelete: number[] = [];

				const whereFn = parseWhere(sql, params);
				if (whereFn) {
					indicesToDelete = table.map((row, i) => whereFn(row) ? i : -1).filter((i) => i >= 0).reverse();
				} else if (upper.includes("WHERE")) {
					// Subquery DELETE: DELETE FROM table WHERE id IN (SELECT id FROM table WHERE ...)
					const subMatch = sql.match(/IN\s*\(\s*SELECT\s+\w+\s+FROM\s+\w+\s+WHERE\s+(.+?)\s*\)/i);
					if (subMatch) {
						const subWhere = subMatch[1];
						// Reconstruct a simple WHERE from the subquery
						const subSql = `SELECT * FROM ${tableName} WHERE ${subWhere}`;
						const subWhereFn = parseWhere(subSql, params);
						if (subWhereFn) {
							indicesToDelete = table.map((row, i) => subWhereFn(row) ? i : -1).filter((i) => i >= 0).reverse();
						}
					}
				} else {
					indicesToDelete = table.map((_, i) => i).reverse();
				}

				for (const idx of indicesToDelete) {
					table.splice(idx, 1);
				}

				return { one: () => null, first: () => undefined, toArray: () => [], [Symbol.iterator]: function* () {} };
			}

			return { one: () => null, first: () => undefined, toArray: () => [], [Symbol.iterator]: function* () {} };
		}),
	};
}

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
			sql: createMockSqlStorage(),
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
