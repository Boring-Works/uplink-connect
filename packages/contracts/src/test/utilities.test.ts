import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	safeJsonStringify,
	safeJsonParse,
	extractJsonObjects,
	extractFirstJsonObject,
	sanitizeObject,
	sanitizeUrl,
	isNonTransientHttpStatus,
	isTransientHttpStatus,
	classifyHttpStatus,
	isTransientConnectionError,
	shouldRetryHttpError,
	parseDuration,
	parseRetryAfter,
	parseRateLimitHeaders,
	fetchWithCache,
	clearFetchCache,
	retryWithDeduplication,
	sampleArray,
} from "../index";

describe("safeJsonStringify", () => {
	it("stringifies plain objects", () => {
		expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
	});

	it("handles circular references", () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;
		expect(safeJsonStringify(obj)).toBe('{"a":1,"self":"[Circular]"}');
	});

	it("handles nested circular references", () => {
		const parent: Record<string, unknown> = { name: "parent" };
		const child: Record<string, unknown> = { name: "child", parent };
		parent.child = child;
		const result = safeJsonStringify(parent);
		expect(result).toContain('"name":"parent"');
		expect(result).toContain('"child":{"name":"child","parent":"[Circular]"}');
	});

	it("converts BigInt to string", () => {
		expect(safeJsonStringify({ value: BigInt(9007199254740993n) })).toBe('{"value":"9007199254740993"}');
	});

	it("converts functions to [Function]", () => {
		expect(safeJsonStringify({ fn: () => 42 })).toBe('{"fn":"[Function]"}');
	});

	it("serializes Error objects", () => {
		const error = new Error("boom");
		const result = safeJsonParse(safeJsonStringify({ error })) as { error: { name: string; message: string } };
		expect(result.error.name).toBe("Error");
		expect(result.error.message).toBe("boom");
	});

	it("returns [Unserializable] on complete failure", () => {
		// BigInt in an object with a custom replacer that throws
		const badObj = {
			get value() {
				throw new Error("Cannot serialize");
			},
		};
		expect(safeJsonStringify(badObj)).toBe("[Unserializable]");
	});

	it("pretty-prints when requested", () => {
		const result = safeJsonStringify({ a: 1 }, true);
		expect(result).toContain("\n");
		expect(result).toContain("  ");
	});
});

describe("safeJsonParse", () => {
	it("parses valid JSON", () => {
		expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
	});

	it("returns undefined for invalid JSON", () => {
		expect(safeJsonParse("not json")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(safeJsonParse("")).toBeUndefined();
	});
});

describe("extractJsonObjects", () => {
	it("extracts objects from text", () => {
		const text = 'Here is some data: {"a":1} and {"b":2}';
		expect(extractJsonObjects(text)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("ignores invalid JSON fragments", () => {
		const text = '{"valid":1} and {invalid} and {"also":2}';
		expect(extractJsonObjects(text)).toEqual([{ valid: 1 }, { also: 2 }]);
	});

	it("returns empty array when no objects found", () => {
		expect(extractJsonObjects("no json here")).toEqual([]);
	});

	it("skips arrays", () => {
		expect(extractJsonObjects("[1,2,3]")).toEqual([]);
	});
});

describe("extractFirstJsonObject", () => {
	it("returns first object", () => {
		expect(extractFirstJsonObject('{"a":1} {"b":2}')).toEqual({ a: 1 });
	});

	it("returns undefined when none found", () => {
		expect(extractFirstJsonObject("no json")).toBeUndefined();
	});
});

describe("sanitizeObject", () => {
	it("redacts known secret fields", () => {
		const input = {
			api_key: "super-secret-key-123",
			normalField: "visible",
		};
		const result = sanitizeObject(input);
		expect(result.api_key).toBe("[REDACTED]");
		expect(result.normalField).toBe("visible");
	});

	it("redacts case variants of secret fields", () => {
		const input = {
			API_KEY: "secret-long-123",
			password: "hunter2000",
			Authorization: "Bearer token123",
		};
		const result = sanitizeObject(input);
		expect(result.API_KEY).toBe("[REDACTED]");
		expect(result.password).toBe("[REDACTED]");
		expect(result.Authorization).toBe("[REDACTED]");
	});

	it("redacts nested secret fields", () => {
		const input = {
			config: {
				secret: "nested-secret-long",
			},
		};
		const result = sanitizeObject(input);
		expect(result.config.secret).toBe("[REDACTED]");
	});

	it("redacts secret-looking values", () => {
		const input = {
			myToken: "sk-abcdefghijklmnopqrstuvwxyz",
		};
		const result = sanitizeObject(input);
		expect(result.myToken).toBe("[REDACTED]");
	});

	it("redacts AWS access keys in values", () => {
		const input = {
			credential: "AKIAIOSFODNN7EXAMPLE",
		};
		const result = sanitizeObject(input);
		expect(result.credential).toBe("[REDACTED]");
	});

	it("handles arrays", () => {
		const input = [
			{ token: "secret1-long" },
			{ token: "secret2-long" },
		];
		const result = sanitizeObject(input);
		expect(result[0].token).toBe("[REDACTED]");
		expect(result[1].token).toBe("[REDACTED]");
	});

	it("does not mutate original", () => {
		const input = { api_key: "secret-long-123" };
		const result = sanitizeObject(input);
		expect(input.api_key).toBe("secret-long-123");
		expect(result.api_key).toBe("[REDACTED]");
	});

	it("handles null and undefined", () => {
		expect(sanitizeObject(null)).toBeNull();
		expect(sanitizeObject(undefined)).toBeUndefined();
	});

	it("handles Dates as ISO strings", () => {
		const date = new Date("2024-01-01");
		const result = sanitizeObject({ createdAt: date });
		expect(result.createdAt).toBe("2024-01-01T00:00:00.000Z");
	});

	it("returns [...] at max depth", () => {
		const input = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
		const result = sanitizeObject(input, { maxDepth: 3 });
		expect(result.a.b.c).toEqual({ d: "[...]" });
	});
});

describe("sanitizeUrl", () => {
	it("redacts credentials from URLs", () => {
		expect(sanitizeUrl("https://user:pass@example.com/path")).toBe("https://***:***@example.com/path");
	});

	it("returns original URL when no credentials", () => {
		expect(sanitizeUrl("https://example.com/path")).toBe("https://example.com/path");
	});

	it("returns original on invalid URL", () => {
		expect(sanitizeUrl("not-a-url")).toBe("not-a-url");
	});
});

describe("HTTP error classification", () => {
	it("identifies non-transient statuses", () => {
		expect(isNonTransientHttpStatus(400)).toBe(true);
		expect(isNonTransientHttpStatus(401)).toBe(true);
		expect(isNonTransientHttpStatus(404)).toBe(true);
		expect(isNonTransientHttpStatus(422)).toBe(true);
		expect(isNonTransientHttpStatus(501)).toBe(true);
	});

	it("identifies transient statuses", () => {
		expect(isTransientHttpStatus(408)).toBe(true);
		expect(isTransientHttpStatus(429)).toBe(true);
		expect(isTransientHttpStatus(500)).toBe(true);
		expect(isTransientHttpStatus(502)).toBe(true);
		expect(isTransientHttpStatus(503)).toBe(true);
		expect(isTransientHttpStatus(504)).toBe(true);
	});

	it("returns false for unknown statuses", () => {
		expect(isNonTransientHttpStatus(200)).toBe(false);
		expect(isTransientHttpStatus(200)).toBe(false);
		expect(isNonTransientHttpStatus(418)).toBe(false);
		expect(isTransientHttpStatus(418)).toBe(false);
	});

	it("classifies statuses correctly", () => {
		expect(classifyHttpStatus(404)).toBe("non-transient");
		expect(classifyHttpStatus(503)).toBe("transient");
		expect(classifyHttpStatus(200)).toBeUndefined();
	});

	it("should not retry non-transient errors", () => {
		expect(shouldRetryHttpError(400)).toBe(false);
		expect(shouldRetryHttpError(401)).toBe(false);
		expect(shouldRetryHttpError(404)).toBe(false);
	});

	it("should retry transient errors", () => {
		expect(shouldRetryHttpError(429)).toBe(true);
		expect(shouldRetryHttpError(503)).toBe(true);
		expect(shouldRetryHttpError(504)).toBe(true);
	});

	it("should retry connection errors even with unknown status", () => {
		expect(shouldRetryHttpError(0, new Error("ECONNRESET"))).toBe(true);
		expect(shouldRetryHttpError(0, new Error("fetch failed"))).toBe(true);
	});

	it("defaults to retry for ambiguous statuses without error", () => {
		expect(shouldRetryHttpError(418)).toBe(true);
	});
});

describe("isTransientConnectionError", () => {
	it("detects network errors", () => {
		expect(isTransientConnectionError(new Error("ECONNRESET"))).toBe(true);
		expect(isTransientConnectionError(new Error("ETIMEDOUT"))).toBe(true);
		expect(isTransientConnectionError(new Error("fetch failed"))).toBe(true);
		expect(isTransientConnectionError(new Error("Network Error"))).toBe(true);
	});

	it("detects timeout errors", () => {
		expect(isTransientConnectionError(new Error("Request timeout"))).toBe(true);
		expect(isTransientConnectionError(new Error("Worker exceeded resource limits"))).toBe(true);
	});

	it("detects gateway errors", () => {
		expect(isTransientConnectionError(new Error("Bad gateway"))).toBe(true);
		expect(isTransientConnectionError(new Error("Gateway timeout"))).toBe(true);
		expect(isTransientConnectionError(new Error("Service unavailable"))).toBe(true);
	});

	it("returns false for non-errors", () => {
		expect(isTransientConnectionError("string")).toBe(false);
		expect(isTransientConnectionError(null)).toBe(false);
		expect(isTransientConnectionError(42)).toBe(false);
	});

	it("returns false for non-transient errors", () => {
		expect(isTransientConnectionError(new Error("Invalid JSON"))).toBe(false);
		expect(isTransientConnectionError(new Error("Unauthorized"))).toBe(false);
	});
});

describe("parseDuration", () => {
	it("parses milliseconds", () => {
		expect(parseDuration("100ms")).toBe(100);
		expect(parseDuration("500ms")).toBe(500);
	});

	it("parses seconds", () => {
		expect(parseDuration("5s")).toBe(5000);
		expect(parseDuration("1.5s")).toBe(1500);
	});

	it("parses minutes", () => {
		expect(parseDuration("2m")).toBe(120_000);
	});

	it("parses minutes and seconds", () => {
		expect(parseDuration("1m30s")).toBe(90_000);
	});

	it("parses hours", () => {
		expect(parseDuration("1h")).toBe(3_600_000);
	});

	it("parses complex durations", () => {
		expect(parseDuration("2h15m30s")).toBe(8_130_000);
	});

	it("returns null for invalid durations", () => {
		expect(parseDuration("not-a-duration")).toBeNull();
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("1d")).toBeNull();
	});
});

describe("parseRetryAfter", () => {
	it("parses seconds", () => {
		expect(parseRetryAfter("60")).toBe(60_000);
		expect(parseRetryAfter("0")).toBe(0);
	});

	it("parses HTTP-date format", () => {
		const future = new Date(Date.now() + 120_000);
		const result = parseRetryAfter(future.toUTCString());
		expect(result).toBeGreaterThanOrEqual(115_000);
		expect(result).toBeLessThanOrEqual(125_000);
	});

	it("returns null for invalid values", () => {
		expect(parseRetryAfter("not-a-number")).toBeNull();
	});
});

describe("parseRateLimitHeaders", () => {
	it("parses OpenAI-style headers", () => {
		const headers = {
			"x-ratelimit-remaining-requests": "10",
			"x-ratelimit-remaining-tokens": "5000",
			"x-ratelimit-limit-requests": "100",
			"x-ratelimit-reset-requests": "1s",
		};
		const result = parseRateLimitHeaders(headers);
		expect(result.remainingRequests).toBe(10);
		expect(result.remainingTokens).toBe(5000);
		expect(result.limitRequests).toBe(100);
		expect(result.resetAt).toBeGreaterThan(Date.now());
	});

	it("parses Anthropic-style headers", () => {
		const headers = {
			"anthropic-ratelimit-requests-remaining": "5",
			"anthropic-ratelimit-requests-limit": "50",
			"anthropic-ratelimit-requests-reset": "2s",
		};
		const result = parseRateLimitHeaders(headers);
		expect(result.remainingRequests).toBe(5);
		expect(result.limitRequests).toBe(50);
		expect(result.resetAt).toBeGreaterThan(Date.now());
	});

	it("parses standard RFC headers", () => {
		const headers = {
			"ratelimit-remaining": "20",
			"ratelimit-limit": "100",
			"ratelimit-reset": "5s",
		};
		const result = parseRateLimitHeaders(headers);
		expect(result.remainingRequests).toBe(20);
		expect(result.limitRequests).toBe(100);
	});

	it("parses Retry-After header", () => {
		const result = parseRateLimitHeaders({ "retry-after": "30" });
		expect(result.retryAfterMs).toBe(30_000);
		expect(result.resetAt).toBeGreaterThan(Date.now());
	});

	it("handles empty headers gracefully", () => {
		const result = parseRateLimitHeaders({});
		expect(result.remainingRequests).toBeUndefined();
		expect(result.resetAt).toBeUndefined();
	});
});

describe("fetchWithCache", () => {
	beforeEach(() => {
		clearFetchCache();
	});

	it("fetches successfully without cache", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
		);
		const response = await fetchWithCache("https://example.com/api");
		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("caches GET responses when cacheTtlMs is set", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
		);
		await fetchWithCache("https://example.com/api", { cacheTtlMs: 60_000 });
		await fetchWithCache("https://example.com/api", { cacheTtlMs: 60_000 });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("does not cache non-GET requests", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response('{"ok":true}', { status: 200 }),
		);
		await fetchWithCache("https://example.com/api", { method: "POST", cacheTtlMs: 60_000 });
		await fetchWithCache("https://example.com/api", { method: "POST", cacheTtlMs: 60_000 });
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it("retries on transient errors", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }))
			.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

		const response = await fetchWithCache("https://example.com/api", { maxRetries: 2, backoffMs: 10 });
		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it("handles rate limiting with retry", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } }))
			.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

		const response = await fetchWithCache("https://example.com/api", { maxRetries: 2, backoffMs: 10 });
		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it("throws after max retries exhausted", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
		);
		await expect(
			fetchWithCache("https://example.com/api", { maxRetries: 1, backoffMs: 10 }),
		).rejects.toThrow("Request failed after 1 retries");
	});

	it("propagates AbortError without retry", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
		await expect(fetchWithCache("https://example.com/api")).rejects.toThrow("Aborted");
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});

describe("retryWithDeduplication", () => {
	it("collects unique items until target count", async () => {
		let callCount = 0;
		const operation = vi.fn().mockImplementation(() => {
			callCount++;
			return Promise.resolve([`item-${callCount}`]);
		});

		const result = await retryWithDeduplication(operation, 3);
		expect(result).toEqual(["item-1", "item-2", "item-3"]);
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it("deduplicates returned items", async () => {
		const operation = vi
			.fn()
			.mockResolvedValueOnce(["a", "b"])
			.mockResolvedValueOnce(["b", "c"])
			.mockResolvedValueOnce(["c", "d"]);

		const result = await retryWithDeduplication(operation, 4, 2);
		expect(result).toEqual(["a", "b", "c", "d"]);
	});

	it("stops after max consecutive retries with no new items", async () => {
		const operation = vi.fn().mockResolvedValue(["a"]);
		const result = await retryWithDeduplication(operation, 5, 1);
		expect(result).toEqual(["a"]);
		expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries (<= maxConsecutiveRetries)
	});

	it("skips non-array results", async () => {
		const operation = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(["a"]);

		const result = await retryWithDeduplication(operation, 1, 2);
		expect(result).toEqual(["a"]);
	});
});

describe("sampleArray", () => {
	it("returns n random items", () => {
		const arr = [1, 2, 3, 4, 5];
		const result = sampleArray(arr, 3);
		expect(result).toHaveLength(3);
		expect(result.every((item) => arr.includes(item))).toBe(true);
	});

	it("returns all items if n > length", () => {
		const arr = [1, 2];
		const result = sampleArray(arr, 5);
		expect(result).toHaveLength(2);
	});

	it("returns empty array for empty input", () => {
		expect(sampleArray([], 3)).toEqual([]);
	});
});
