import { describe, expect, it, vi } from "vitest";
import {
	createSourceAdapter,
	ApiSourceAdapter,
	BrowserSourceAdapter,
	WebhookSourceAdapter,
	GenericSourceAdapter,
} from "../index";

describe("createSourceAdapter", () => {
	it("creates api adapter", () => {
		const adapter = createSourceAdapter("api");
		expect(adapter).toBeInstanceOf(ApiSourceAdapter);
		expect(adapter.type).toBe("api");
	});

	it("creates browser adapter", () => {
		const adapter = createSourceAdapter("browser");
		expect(adapter).toBeInstanceOf(BrowserSourceAdapter);
		expect(adapter.type).toBe("browser");
	});

	it("creates webhook adapter", () => {
		const adapter = createSourceAdapter("webhook");
		expect(adapter).toBeInstanceOf(WebhookSourceAdapter);
		expect(adapter.type).toBe("webhook");
	});

	it("creates generic adapter for manual type", () => {
		const adapter = createSourceAdapter("manual");
		expect(adapter).toBeInstanceOf(GenericSourceAdapter);
		expect(adapter.type).toBe("manual");
	});

	it("creates generic adapter for email type", () => {
		const adapter = createSourceAdapter("email");
		expect(adapter).toBeInstanceOf(GenericSourceAdapter);
		expect(adapter.type).toBe("email");
	});

	it("creates generic adapter for file type", () => {
		const adapter = createSourceAdapter("file");
		expect(adapter).toBeInstanceOf(GenericSourceAdapter);
		expect(adapter.type).toBe("file");
	});

	it("creates generic adapter for stream type", () => {
		const adapter = createSourceAdapter("stream");
		expect(adapter).toBeInstanceOf(GenericSourceAdapter);
		expect(adapter.type).toBe("stream");
	});
});

describe("ApiSourceAdapter", () => {
	it("collects from API endpoint", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([{ id: "1", name: "Item 1" }]), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test API",
				sourceType: "api",
				endpointUrl: "https://api.example.com/data",
				requestMethod: "GET",
				requestHeaders: { Authorization: "Bearer token" },
				metadata: {},
			},
			{
				fetchFn: mockFetch,
				nowIso: () => "2026-04-13T10:00:00Z",
			}
		);

		expect(result.records).toHaveLength(1);
		expect(result.hasMore).toBe(false);
		expect(mockFetch).toHaveBeenCalledWith("https://api.example.com/data", {
			method: "GET",
			headers: { accept: "application/json", Authorization: "Bearer token" },
			body: undefined,
		});
	});

	it("throws when endpointUrl is missing", async () => {
		const adapter = new ApiSourceAdapter();
		await expect(
			adapter.collect(
				{
					sourceId: "src-1",
					sourceName: "Test API",
					sourceType: "api",
					requestMethod: "GET",
					requestHeaders: {},
					metadata: {},
				},
				{ fetchFn: vi.fn(), nowIso: () => "2026-04-13T10:00:00Z" }
			)
		).rejects.toThrow("missing endpointUrl");
	});

	it("throws on non-ok response", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(new Response("Error", { status: 500 }));

		await expect(
			adapter.collect(
				{
					sourceId: "src-1",
					sourceName: "Test API",
					sourceType: "api",
					endpointUrl: "https://api.example.com/data",
					requestMethod: "GET",
					requestHeaders: {},
					metadata: {},
				},
				{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
			)
		).rejects.toThrow("responded 500");
	});

	it("handles single object response", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ id: "1", name: "Item 1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test API",
				sourceType: "api",
				endpointUrl: "https://api.example.com/data",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.records).toHaveLength(1);
	});

	it("uses POST method when configured", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([]), { status: 200 })
		);

		await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test API",
				sourceType: "api",
				endpointUrl: "https://api.example.com/data",
				requestMethod: "POST",
				requestBody: '{"filter":"active"}',
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/data",
			expect.objectContaining({ method: "POST", body: '{"filter":"active"}' })
		);
	});

	it("returns hasMore false for API responses", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [{ id: "1" }],
					nextCursor: "cursor-2",
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			)
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test API",
				sourceType: "api",
				endpointUrl: "https://api.example.com/data",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		// ApiSourceAdapter always returns hasMore: false
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeUndefined();
	});

	it("handles empty array response", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test API",
				sourceType: "api",
				endpointUrl: "https://api.example.com/data",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.records).toHaveLength(0);
		expect(result.hasMore).toBe(false);
	});

	it("includes externalId from payload id field", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([{ id: "item-1" }]), { status: 200, headers: { "content-type": "application/json" } })
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test API",
				sourceType: "api",
				endpointUrl: "https://api.example.com/data",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.records[0].externalId).toBe("item-1");
	});
});

describe("BrowserSourceAdapter", () => {
	it("collects via browser fetcher", async () => {
		const adapter = new BrowserSourceAdapter();
		const mockBrowserFetcher = {
			fetch: vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						records: [{ body: "<html>...</html>" }],
						hasMore: false,
					}),
					{ status: 200 }
				)
			),
		} as unknown as Fetcher;

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test Browser",
				sourceType: "browser",
				endpointUrl: "https://example.com",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{
				fetchFn: vi.fn(),
				browserFetcher: mockBrowserFetcher,
				nowIso: () => "2026-04-13T10:00:00Z",
			}
		);

		expect(result.records).toHaveLength(1);
		expect(mockBrowserFetcher.fetch).toHaveBeenCalledWith(
			"https://uplink-browser/internal/collect",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("https://example.com"),
			})
		);
	});

	it("throws when browserFetcher is missing", async () => {
		const adapter = new BrowserSourceAdapter();
		await expect(
			adapter.collect(
				{
					sourceId: "src-1",
					sourceName: "Test Browser",
					sourceType: "browser",
					endpointUrl: "https://example.com",
					requestMethod: "GET",
					requestHeaders: {},
					metadata: {},
				},
				{ fetchFn: vi.fn(), nowIso: () => "2026-04-13T10:00:00Z" }
			)
		).rejects.toThrow("browserFetcher binding");
	});

	it("passes cursor to browser collector", async () => {
		const adapter = new BrowserSourceAdapter();
		const mockBrowserFetcher = {
			fetch: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ records: [], hasMore: false }), { status: 200 })
			),
		} as unknown as Fetcher;

		await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test Browser",
				sourceType: "browser",
				endpointUrl: "https://example.com",
				requestMethod: "GET",
				requestHeaders: {},
				cursor: "page-2",
				metadata: {},
			},
			{
				fetchFn: vi.fn(),
				browserFetcher: mockBrowserFetcher,
				nowIso: () => "2026-04-13T10:00:00Z",
			}
		);

		const body = JSON.parse((mockBrowserFetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		expect(body.cursor).toBe("page-2");
	});

	it("passes custom headers to browser collector", async () => {
		const adapter = new BrowserSourceAdapter();
		const mockBrowserFetcher = {
			fetch: vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ records: [], hasMore: false }), { status: 200 })
			),
		} as unknown as Fetcher;

		await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test Browser",
				sourceType: "browser",
				endpointUrl: "https://example.com",
				requestMethod: "GET",
				requestHeaders: { "x-custom": "value" },
				metadata: {},
			},
			{
				fetchFn: vi.fn(),
				browserFetcher: mockBrowserFetcher,
				nowIso: () => "2026-04-13T10:00:00Z",
			}
		);

		const body = JSON.parse((mockBrowserFetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		expect(body.headers).toEqual({ "x-custom": "value" });
	});

	it("throws on non-ok browser response", async () => {
		const adapter = new BrowserSourceAdapter();
		const mockBrowserFetcher = {
			fetch: vi.fn().mockResolvedValue(new Response("Error", { status: 500 })),
		} as unknown as Fetcher;

		await expect(
			adapter.collect(
				{
					sourceId: "src-1",
					sourceName: "Test Browser",
					sourceType: "browser",
					endpointUrl: "https://example.com",
					requestMethod: "GET",
					requestHeaders: {},
					metadata: {},
				},
				{
					fetchFn: vi.fn(),
					browserFetcher: mockBrowserFetcher,
					nowIso: () => "2026-04-13T10:00:00Z",
				}
			)
		).rejects.toThrow("Browser collector failed");
	});
});

describe("WebhookSourceAdapter", () => {
	it("always throws because webhooks are push-based", async () => {
		const adapter = new WebhookSourceAdapter();
		await expect(adapter.collect()).rejects.toThrow("push-based");
	});
});

describe("GenericSourceAdapter", () => {
	it("returns empty records when endpointUrl is missing", async () => {
		const adapter = new GenericSourceAdapter("email");
		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test Email",
				sourceType: "email",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: vi.fn(), nowIso: () => "2026-04-13T10:00:00Z" }
		);
		expect(result.records).toHaveLength(0);
		expect(result.hasMore).toBe(false);
	});

	it("fetches and wraps response", async () => {
		const adapter = new GenericSourceAdapter("stream");
		const mockFetch = vi.fn().mockResolvedValue(
			new Response("stream data", { status: 200 })
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test Stream",
				sourceType: "stream",
				endpointUrl: "https://stream.example.com",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.records).toHaveLength(1);
		expect(result.records[0].rawPayload).toEqual({
			responseStatus: 200,
			body: "stream data",
		});
	});

	it("wraps non-ok response in record", async () => {
		const adapter = new GenericSourceAdapter("stream");
		const mockFetch = vi.fn().mockResolvedValue(new Response("Error", { status: 503 }));

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test Stream",
				sourceType: "stream",
				endpointUrl: "https://stream.example.com",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.records).toHaveLength(1);
		expect(result.records[0].rawPayload).toMatchObject({ responseStatus: 503 });
	});

	it("includes externalId with sourceId prefix", async () => {
		const adapter = new GenericSourceAdapter("file");
		const mockFetch = vi.fn().mockResolvedValue(
			new Response("file content", { status: 200 })
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test File",
				sourceType: "file",
				endpointUrl: "https://files.example.com/data.txt",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.records[0].externalId).toMatch(/^src-1:/);
	});

	it("uses POST method when configured", async () => {
		const adapter = new GenericSourceAdapter("manual");
		const mockFetch = vi.fn().mockResolvedValue(
			new Response("ok", { status: 200 })
		);

		await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test Manual",
				sourceType: "manual",
				endpointUrl: "https://example.com/manual",
				requestMethod: "POST",
				requestBody: '{"action":"sync"}',
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(mockFetch).toHaveBeenCalledWith(
			"https://example.com/manual",
			expect.objectContaining({ method: "POST", body: '{"action":"sync"}' })
		);
	});

	it("returns hasMore false for generic adapter", async () => {
		const adapter = new GenericSourceAdapter("stream");
		const mockFetch = vi.fn().mockResolvedValue(
			new Response("data", { status: 200 })
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test Stream",
				sourceType: "stream",
				endpointUrl: "https://stream.example.com",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.hasMore).toBe(false);
	});
});

describe("ApiSourceAdapter edge cases", () => {
	it("wraps paginated object response as single record", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [{ id: "1" }, { id: "2" }],
					total: 100,
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			)
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test API",
				sourceType: "api",
				endpointUrl: "https://api.example.com/data",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.records).toHaveLength(1);
		expect(result.records[0].rawPayload).toMatchObject({ total: 100 });
	});

	it("wraps results object response as single record", async () => {
		const adapter = new ApiSourceAdapter();
		const mockFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [{ id: "a" }, { id: "b" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			)
		);

		const result = await adapter.collect(
			{
				sourceId: "src-1",
				sourceName: "Test API",
				sourceType: "api",
				endpointUrl: "https://api.example.com/data",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: {},
			},
			{ fetchFn: mockFetch, nowIso: () => "2026-04-13T10:00:00Z" }
		);

		expect(result.records).toHaveLength(1);
		expect(result.records[0].rawPayload).toHaveProperty("results");
	});
});
