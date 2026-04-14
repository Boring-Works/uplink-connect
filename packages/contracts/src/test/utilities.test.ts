import { describe, it, expect } from "vitest";
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
		expect(result.api_key).toBe("sup***123");
		expect(result.normalField).toBe("visible");
	});

	it("redacts case variants of secret fields", () => {
		const input = {
			API_KEY: "secret-long-123",
			password: "hunter2000",
			Authorization: "Bearer token123",
		};
		const result = sanitizeObject(input);
		expect(result.API_KEY).toBe("sec***123");
		expect(result.password).toBe("hun***000");
		expect(result.Authorization).toBe("Bea***123");
	});

	it("redacts nested secret fields", () => {
		const input = {
			config: {
				secret: "nested-secret-long",
			},
		};
		const result = sanitizeObject(input);
		expect(result.config.secret).toBe("nes***ong");
	});

	it("redacts secret-looking values", () => {
		const input = {
			myToken: "sk-abcdefghijklmnopqrstuvwxyz",
		};
		const result = sanitizeObject(input);
		expect(result.myToken).toBe("sk-***xyz");
	});

	it("redacts AWS access keys in values", () => {
		const input = {
			credential: "AKIAIOSFODNN7EXAMPLE",
		};
		const result = sanitizeObject(input);
		expect(result.credential).toBe("AKI***PLE");
	});

	it("handles arrays", () => {
		const input = [
			{ token: "secret1-long" },
			{ token: "secret2-long" },
		];
		const result = sanitizeObject(input);
		expect(result[0].token).toBe("sec***ong");
		expect(result[1].token).toBe("sec***ong");
	});

	it("does not mutate original", () => {
		const input = { api_key: "secret-long-123" };
		const result = sanitizeObject(input);
		expect(input.api_key).toBe("secret-long-123");
		expect(result.api_key).toBe("sec***123");
	});

	it("handles null and undefined", () => {
		expect(sanitizeObject(null)).toBeNull();
		expect(sanitizeObject(undefined)).toBeUndefined();
	});

	it("handles Dates", () => {
		const date = new Date("2024-01-01");
		const result = sanitizeObject({ createdAt: date });
		expect(result.createdAt).toBeInstanceOf(Date);
		expect(result.createdAt.getTime()).toBe(date.getTime());
	});

	it("returns [MaxDepth] at max depth", () => {
		const input = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
		const result = sanitizeObject(input, 3);
		expect(result.a.b.c).toBe("[MaxDepth]");
	});
});

describe("sanitizeUrl", () => {
	it("strips credentials from URLs", () => {
		expect(sanitizeUrl("https://user:pass@example.com/path")).toBe("https://example.com/path");
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
