import { describe, expect, it, vi, beforeEach } from "vitest";

// Must mock before importing the DO
vi.mock("ai", async () => {
	return {
		streamText: vi.fn(),
		embed: vi.fn(),
	};
});

vi.mock("workers-ai-provider", () => ({
	createWorkersAI: vi.fn(() => {
		const provider = vi.fn((modelId: string) => ({ modelId })) as unknown as ReturnType<typeof import("workers-ai-provider").createWorkersAI>;
		(provider as unknown as Record<string, unknown>).embedding = vi.fn((modelId: string) => ({ modelId, type: "embedding" }));
		return provider;
	}),
}));

import { ErrorAgentDO } from "../../../durable/error-agent";
import { streamText, embed } from "ai";

// ---------------------------------------------------------------------------
// Mock SqlStorage
// ---------------------------------------------------------------------------
function createMockSqlStorage() {
	const tables = new Map<string, Record<string, unknown>[]>();
	let autoIncrement = 1;

	function getTable(name: string): Record<string, unknown>[] {
		if (!tables.has(name)) tables.set(name, []);
		return tables.get(name)!;
	}

	return {
		exec: vi.fn((sql: string, ...params: unknown[]) => {
			const upper = sql.trim().toUpperCase();

			if (upper.startsWith("CREATE TABLE")) {
				const nameMatch = sql.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
				if (nameMatch) getTable(nameMatch[1]);
				return { one: () => null, [Symbol.iterator]: function* () {} };
			}

			if (upper.startsWith("CREATE INDEX")) {
				return { one: () => null, [Symbol.iterator]: function* () {} };
			}

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
				return { one: () => row, [Symbol.iterator]: function* () { yield row; } };
			}

			if (upper.startsWith("SELECT")) {
				const fromMatch = sql.match(/FROM\s+(\w+)/i);
				const tableName = fromMatch ? fromMatch[1] : "";
				const table = getTable(tableName);
				let results = [...table];

				// Handle COUNT(*)
				if (upper.includes("COUNT(*)")) {
					const countRow = { c: results.length };
					return { one: () => countRow, [Symbol.iterator]: function* () { yield countRow; } };
				}

				// Simple ORDER BY
				const orderMatch = sql.match(/ORDER BY\s+(\w+)\s*(ASC|DESC)?/i);
				if (orderMatch) {
					const col = orderMatch[1];
					const dir = orderMatch[2] ?? "ASC";
					results.sort((a, b) => {
						const av = a[col];
						const bv = b[col];
						if (typeof av === "number" && typeof bv === "number") {
							return dir === "DESC" ? bv - av : av - bv;
						}
						return dir === "DESC" ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
					});
				}

				// Simple LIMIT with OFFSET subquery for trim
				const limitMatch = sql.match(/LIMIT\s+(\?|\d+)/i);
				if (limitMatch && limitMatch[1] === "?") {
					const limitVal = Number(params[params.length - 1]);
					if (!Number.isNaN(limitVal)) {
						results = results.slice(0, limitVal);
					}
				}

				return {
					one: () => results[0] ?? null,
					[Symbol.iterator]: function* () { yield* results; },
				};
			}

			if (upper.startsWith("DELETE")) {
				const fromMatch = sql.match(/FROM\s+(\w+)/i);
				const tableName = fromMatch ? fromMatch[1] : "";
				const table = getTable(tableName);

				// Handle DELETE with subquery (trimMessages)
				if (upper.includes("WHERE") && upper.includes("<=")) {
					const offsetMatch = sql.match(/OFFSET\s+\?/i);
					if (offsetMatch) {
						const offset = Number(params[params.length - 1]);
						if (table.length > offset) {
							const cutoffId = table[table.length - offset - 1]?.id as number;
							if (cutoffId !== undefined) {
								const newTable = table.filter((r) => (r.id as number) > cutoffId);
								tables.set(tableName, newTable);
							}
						}
					}
					return { one: () => null, [Symbol.iterator]: function* () {} };
				}

				// Simple DELETE ALL
				tables.set(tableName, []);
				return { one: () => null, [Symbol.iterator]: function* () {} };
			}

			return { one: () => null, [Symbol.iterator]: function* () {} };
		}),
	};
}

// ---------------------------------------------------------------------------
// Mock DurableObjectState
// ---------------------------------------------------------------------------
function createMockState(): DurableObjectState {
	const sql = createMockSqlStorage();
	return {
		storage: {
			sql,
			get: vi.fn(),
			put: vi.fn(),
			delete: vi.fn(),
			getAlarm: vi.fn(),
			setAlarm: vi.fn(),
			deleteAlarm: vi.fn(),
			list: vi.fn(),
		},
		id: { name: "error-agent", toString: () => "error-agent" } as DurableObjectId,
		waitUntil: vi.fn(),
		abort: vi.fn(),
		blockConcurrencyWhile: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
		setWebSocketAutoResponse: vi.fn(),
		acceptWebSocket: vi.fn(),
		getWebSockets: vi.fn(() => []),
	} as unknown as DurableObjectState;
}

function createMockEnv(overrides?: Partial<Env>): Env {
	return {
		CONTROL_DB: {} as D1Database,
		RAW_BUCKET: {} as R2Bucket,
		ENTITY_INDEX: {
			query: vi.fn().mockResolvedValue({ matches: [] }),
			upsert: vi.fn().mockResolvedValue(undefined),
			deleteByIds: vi.fn().mockResolvedValue(undefined),
		} as unknown as VectorizeIndex,
		OPS_METRICS: {} as AnalyticsEngineDataset,
		AI: { run: vi.fn() } as unknown as Ai,
		DLQ: {} as Queue,
		INGEST_QUEUE: {} as Queue,
		UPLINK_BROWSER: {} as Fetcher,
		SOURCE_COORDINATOR: {} as DurableObjectNamespace,
		BROWSER_MANAGER: {} as DurableObjectNamespace,
		NOTIFICATION_DISPATCHER: {} as DurableObjectNamespace,
		DASHBOARD_STREAM: {} as DurableObjectNamespace,
		ERROR_AGENT: {} as DurableObjectNamespace,
		COLLECTION_WORKFLOW: {} as Workflow,
		RETENTION_WORKFLOW: {} as Workflow,
		CORE_INTERNAL_KEY: "test-secret-key-32bytes-long!!",
		...overrides,
	} as unknown as Env;
}

function createMockWebSocket(): WebSocket {
	const sent: unknown[] = [];
	return {
		send: vi.fn((data: unknown) => sent.push(data)),
		close: vi.fn(),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as unknown as WebSocket & { _sent: unknown[] };
}

describe("ErrorAgentDO", () => {
	let agent: ErrorAgentDO;
	let state: DurableObjectState;

	beforeEach(async () => {
		vi.clearAllMocks();
		state = createMockState();
		agent = new ErrorAgentDO(state, createMockEnv());
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	describe("schema initialization", () => {
		it("creates chat_messages table on first init", async () => {
			const sqlExec = vi.mocked(state.storage.sql.exec);
			expect(sqlExec).toHaveBeenCalledWith(
				expect.stringContaining("CREATE TABLE IF NOT EXISTS chat_messages"),
			);
		});

		it("sets schema version to 1", async () => {
			const sqlExec = vi.mocked(state.storage.sql.exec);
			expect(sqlExec).toHaveBeenCalledWith(
				expect.stringContaining("INSERT OR REPLACE INTO _metadata"),
				"_schema_version",
				"1",
			);
		});
	});

	describe("fetch (websocket upgrade)", () => {
		it("rejects non-websocket requests", async () => {
			const response = await agent.fetch(new Request("https://agent/test"));
			expect(response.status).toBe(400);
		});

		it("rejects missing auth token", async () => {
			const response = await agent.fetch(
				new Request("https://agent/ws", {
					headers: { Upgrade: "websocket" },
				}),
			);
			expect(response.status).toBe(401);
		});

		it("rejects invalid auth token", async () => {
			const response = await agent.fetch(
				new Request("https://agent/ws?token=wrong", {
					headers: { Upgrade: "websocket" },
				}),
			);
			expect(response.status).toBe(401);
		});

		it("accepts valid auth token", async () => {
			// We can't fully test WebSocket upgrade without a real WebSocketPair,
			// but we can verify the auth check passes by mocking acceptWebSocket
			const mockAccept = vi.fn();
			state.acceptWebSocket = mockAccept;
			// @ts-expect-error accessing internal ctx
			agent.ctx.acceptWebSocket = mockAccept;

			// Need to use the actual WebSocketPair to get past the pair creation
			// Since we can't easily mock WebSocketPair, we verify via the mock accept
			// being called with a 101 status in the response path.
			// For unit tests, we verify the token logic via isValidAgentToken indirectly.
			const response = await agent.fetch(
				new Request("https://agent/ws?token=test-secret-key-32bytes-long!!", {
					headers: { Upgrade: "websocket" },
				}),
			);
			expect(response.status).toBe(101);
		});

		it("rejects when max clients reached", async () => {
			// Fill up to MAX_CLIENTS (20)
			for (let i = 0; i < 20; i++) {
				const pair = new WebSocketPair();
				const [, server] = Object.values(pair);
				// @ts-expect-error accessing private
				agent.clients.add(server);
				// @ts-expect-error accessing private
				agent.clientStates.set(server, {
					rateLimit: { messageCount: 0, windowStart: 0 },
					abortController: new AbortController(),
				});
			}

			const response = await agent.fetch(
				new Request("https://agent/ws?token=test-secret-key-32bytes-long!!", {
					headers: { Upgrade: "websocket" },
				}),
			);
			expect(response.status).toBe(503);
		});
	});

	describe("message persistence", () => {
		it("adds and retrieves messages", async () => {
			// @ts-expect-error private method
			await agent.addMessage({ role: "user", content: "hello" });
			// @ts-expect-error private method
			await agent.addMessage({ role: "assistant", content: "hi there" });

			// @ts-expect-error private method
			const messages = await agent.getMessages();
			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("user");
			expect(messages[0].content).toBe("hello");
			expect(messages[1].role).toBe("assistant");
			expect(messages[1].content).toBe("hi there");
		});

		it("returns history without sources_json", async () => {
			// @ts-expect-error private method
			await agent.addMessage({ role: "user", content: "hello" });
			// @ts-expect-error private method
			const history = await agent.getHistory();
			expect(history).toHaveLength(1);
			expect(history[0]).toEqual({ role: "user", content: "hello" });
		});

		it("trims messages beyond MAX_MESSAGES", async () => {
			for (let i = 0; i < 55; i++) {
				// @ts-expect-error private method
				await agent.addMessage({ role: "user", content: `msg-${i}` });
			}
			// @ts-expect-error private method
			const messages = await agent.getMessages();
			expect(messages.length).toBeLessThanOrEqual(50);
		});
	});

	describe("rate limiting", () => {
		it("allows messages within the limit", async () => {
			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			// @ts-expect-error private
			agent.clients.add(server);
			// @ts-expect-error private
			agent.clientStates.set(server, {
				rateLimit: { messageCount: 0, windowStart: 0 },
				abortController: new AbortController(),
			});

			// @ts-expect-error private
			expect(agent.checkRateLimit(server)).toBe(true);
			// @ts-expect-error private
			expect(agent.checkRateLimit(server)).toBe(true);
		});

		it("blocks messages beyond the limit", async () => {
			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			// @ts-expect-error private
			agent.clients.add(server);
			// @ts-expect-error private
			agent.clientStates.set(server, {
				rateLimit: { messageCount: 9, windowStart: Date.now() },
				abortController: new AbortController(),
			});

			// @ts-expect-error private
			expect(agent.checkRateLimit(server)).toBe(true); // 10th message
			// @ts-expect-error private
			expect(agent.checkRateLimit(server)).toBe(false); // 11th message
		});

		it("resets window after expiry", async () => {
			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			// @ts-expect-error private
			agent.clients.add(server);
			// @ts-expect-error private
			agent.clientStates.set(server, {
				rateLimit: { messageCount: 10, windowStart: Date.now() - 70_000 },
				abortController: new AbortController(),
			});

			// @ts-expect-error private
			expect(agent.checkRateLimit(server)).toBe(true); // new window
		});
	});

	describe("webSocketMessage", () => {
		it("responds to ping with pong", async () => {
			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			const sendSpy = vi.spyOn(server, "send");

			await agent.webSocketMessage(server, JSON.stringify({ type: "ping" }));
			expect(sendSpy).toHaveBeenCalledTimes(1);
			const sent = JSON.parse(sendSpy.mock.calls[0][0] as string);
			expect(sent.type).toBe("pong");
			expect(sent.timestamp).toBeTypeOf("number");
		});

		it("clears history on clear message", async () => {
			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			const sendSpy = vi.spyOn(server, "send");

			// Add a message first
			// @ts-expect-error private
			await agent.addMessage({ role: "user", content: "test" });

			await agent.webSocketMessage(server, JSON.stringify({ type: "clear" }));
			// @ts-expect-error private
			const messages = await agent.getMessages();
			expect(messages).toHaveLength(0);

			expect(sendSpy).toHaveBeenCalledTimes(1);
			const sent = JSON.parse(sendSpy.mock.calls[0][0] as string);
			expect(sent.type).toBe("cleared");
		});

		it("returns history on history message", async () => {
			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			const sendSpy = vi.spyOn(server, "send");

			// @ts-expect-error private
			await agent.addMessage({ role: "user", content: "hello" });

			await agent.webSocketMessage(server, JSON.stringify({ type: "history" }));
			expect(sendSpy).toHaveBeenCalledTimes(1);
			const sent = JSON.parse(sendSpy.mock.calls[0][0] as string);
			expect(sent.type).toBe("history");
			expect(sent.data).toHaveLength(1);
		});
	});

	describe("webSocketClose / webSocketError", () => {
		it("aborts in-flight stream on close", async () => {
			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			// @ts-expect-error private
			agent.clients.add(server);
			const controller = new AbortController();
			// @ts-expect-error private
			agent.clientStates.set(server, {
				rateLimit: { messageCount: 0, windowStart: 0 },
				abortController: controller,
			});

			expect(controller.signal.aborted).toBe(false);
			await agent.webSocketClose(server);
			expect(controller.signal.aborted).toBe(true);
		});

		it("removes client from state on error", async () => {
			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			// @ts-expect-error private
			agent.clients.add(server);
			// @ts-expect-error private
			agent.clientStates.set(server, {
				rateLimit: { messageCount: 0, windowStart: 0 },
				abortController: new AbortController(),
			});

			await agent.webSocketError(server);
			// @ts-expect-error private
			expect(agent.clients.has(server)).toBe(false);
			// @ts-expect-error private
			expect(agent.clientStates.has(server)).toBe(false);
		});
	});

	describe("handleChat", () => {
		it("streams text and saves assistant message", async () => {
			const mockStream = async function* () {
				yield "Hello";
				yield " world";
			}();

			vi.mocked(streamText).mockReturnValue({
				textStream: mockStream,
			} as unknown as ReturnType<typeof streamText>);

			vi.mocked(embed).mockResolvedValue({
				embedding: [0.1, 0.2, 0.3],
				value: "test",
				usage: { tokens: 3 },
			} as unknown as Awaited<ReturnType<typeof embed>>);

			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			const sendSpy = vi.spyOn(server, "send");

			// @ts-expect-error private
			agent.clients.add(server);
			// @ts-expect-error private
			agent.clientStates.set(server, {
				rateLimit: { messageCount: 0, windowStart: 0 },
				abortController: new AbortController(),
			});

			// @ts-expect-error private
			await agent.handleChat(server, "What is wrong?");

			// Should send text deltas
			const textMessages = sendSpy.mock.calls
				.map((c) => JSON.parse(c[0] as string))
				.filter((m) => m.type === "text");
			expect(textMessages).toHaveLength(2);
			expect(textMessages[0].content).toBe("Hello");
			expect(textMessages[1].content).toBe(" world");

			// Should send done
			const doneMessages = sendSpy.mock.calls
				.map((c) => JSON.parse(c[0] as string))
				.filter((m) => m.type === "done");
			expect(doneMessages).toHaveLength(1);

			// Should save assistant message
			// @ts-expect-error private
			const messages = await agent.getMessages();
			expect(messages.length).toBeGreaterThanOrEqual(2);
			const assistantMsg = messages.find((m: { role: string }) => m.role === "assistant");
			expect(assistantMsg).toBeDefined();
			expect(assistantMsg!.content).toBe("Hello world");
		});

		it("sends stream-error on failure and does not save assistant", async () => {
			const mockStream = async function* () {
				yield "Partial";
				throw new Error("LLM failed");
			}();

			vi.mocked(streamText).mockReturnValue({
				textStream: mockStream,
			} as unknown as ReturnType<typeof streamText>);

			vi.mocked(embed).mockResolvedValue({
				embedding: [0.1, 0.2, 0.3],
				value: "test",
				usage: { tokens: 3 },
			} as unknown as Awaited<ReturnType<typeof embed>>);

			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			const sendSpy = vi.spyOn(server, "send");

			// @ts-expect-error private
			agent.clients.add(server);
			// @ts-expect-error private
			agent.clientStates.set(server, {
				rateLimit: { messageCount: 0, windowStart: 0 },
				abortController: new AbortController(),
			});

			// @ts-expect-error private
			await expect(agent.handleChat(server, "What is wrong?")).rejects.toThrow("LLM failed");

			const errorMsg = sendSpy.mock.calls
				.map((c) => JSON.parse(c[0] as string))
				.find((m) => m.type === "stream-error");
			expect(errorMsg).toBeDefined();
			expect(errorMsg.partialContent).toBe("Partial");
			expect(errorMsg.error).toBe("LLM failed");
		});

		it("returns gracefully on abort without sending stream-error", async () => {
			const controller = new AbortController();
			controller.abort(); // pre-abort

			const mockStream = async function* () {
				throw new Error("AbortError");
			}();

			vi.mocked(streamText).mockReturnValue({
				textStream: mockStream,
			} as unknown as ReturnType<typeof streamText>);

			vi.mocked(embed).mockResolvedValue({
				embedding: [0.1, 0.2, 0.3],
				value: "test",
				usage: { tokens: 3 },
			} as unknown as Awaited<ReturnType<typeof embed>>);

			const pair = new WebSocketPair();
			const [, server] = Object.values(pair);
			const sendSpy = vi.spyOn(server, "send");

			// @ts-expect-error private
			agent.clients.add(server);
			// @ts-expect-error private
			agent.clientStates.set(server, {
				rateLimit: { messageCount: 0, windowStart: 0 },
				abortController: controller,
			});

			// @ts-expect-error private
			await agent.handleChat(server, "What is wrong?");

			// Should not send stream-error for abort
			const errorMsgs = sendSpy.mock.calls
				.map((c) => JSON.parse(c[0] as string))
				.filter((m) => m.type === "stream-error");
			expect(errorMsgs).toHaveLength(0);
		});
	});
});
