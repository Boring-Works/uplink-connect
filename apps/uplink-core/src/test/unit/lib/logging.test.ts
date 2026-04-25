import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Logger, Span, extractContextFromRequest, injectContextIntoRequest } from "../../../lib/logging";

describe("Logger", () => {
	let logger: Logger;
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logger = new Logger("test-service", "debug");
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	it("logs debug messages", () => {
		logger.debug("test debug");
		expect(consoleSpy).toHaveBeenCalledTimes(1);
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.level).toBe("debug");
		expect(entry.message).toBe("test debug");
		expect(entry.service).toBe("test-service");
	});

	it("logs info messages", () => {
		logger.info("test info", { runId: "run-1" });
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.level).toBe("info");
		expect(entry.context.runId).toBe("run-1");
	});

	it("logs warn messages", () => {
		logger.warn("test warn", { sourceId: "src-1" }, { durationMs: 100 });
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.level).toBe("warn");
		expect(entry.metrics.durationMs).toBe(100);
	});

	it("logs error messages with error details", () => {
		const error = new Error("something failed");
		logger.error("test error", {}, undefined, error);
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.level).toBe("error");
		expect(entry.error.message).toBe("something failed");
		expect(entry.error.name).toBe("Error");
	});

	it("logs fatal messages", () => {
		logger.fatal("test fatal");
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.level).toBe("fatal");
	});

	it("respects minLevel filter", () => {
		const filteredLogger = new Logger("test", "warn");
		filteredLogger.debug("should not appear");
		filteredLogger.info("should not appear");
		expect(consoleSpy).toHaveBeenCalledTimes(0);
		filteredLogger.warn("should appear");
		expect(consoleSpy).toHaveBeenCalledTimes(1);
	});

	it("creates child logger with merged context", () => {
		const child = logger.withContext({ runId: "run-1" });
		child.info("child log", { sourceId: "src-1" });
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.context.runId).toBe("run-1");
		expect(entry.context.sourceId).toBe("src-1");
	});

	it("includes timestamp in ISO format", () => {
		logger.info("test");
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
	});
});

describe("Span", () => {
	let logger: Logger;
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logger = new Logger("test", "debug");
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	it("creates span with unique IDs", () => {
		const span1 = new Span("op1", logger);
		const span2 = new Span("op2", logger);
		expect(span1.getTraceId()).not.toBe(span2.getTraceId());
		expect(span1.getSpanId()).not.toBe(span2.getSpanId());
		span1.end();
		span2.end();
	});

	it("creates child span with same traceId", () => {
		const parent = new Span("parent", logger);
		const child = parent.child("child");
		expect(child.getTraceId()).toBe(parent.getTraceId());
		parent.end();
		child.end();
	});

	it("logs span start", () => {
		const span = new Span("test-op", logger);
		span.end();
		const entries = consoleSpy.mock.calls.map((call) => JSON.parse(call[0]));
		expect(entries.some((e: { message: string }) => e.message.includes("Span started"))).toBe(true);
	});

	it("logs span end with duration", () => {
		const span = new Span("test-op", logger);
		span.end();
		const entry = JSON.parse(consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0]);
		expect(entry.message).toContain("Span ended");
		expect(entry.metrics.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("logs error status on failure", () => {
		const span = new Span("test-op", logger);
		const error = new Error("failed");
		span.end("error", error);
		const entry = JSON.parse(consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0]);
		expect(entry.level).toBe("error");
		expect(entry.error.message).toBe("failed");
	});

	it("adds events to span", () => {
		const span = new Span("test-op", logger);
		span.addEvent("checkpoint", { value: 42 });
		span.end();
		const entries = consoleSpy.mock.calls.map((call) => JSON.parse(call[0]));
		expect(entries.some((e: { context: { eventName: string } }) => e.context?.eventName === "checkpoint")).toBe(true);
	});

	it("sets attributes on span", () => {
		const span = new Span("test-op", logger, undefined, { initial: "value" });
		span.setAttribute("added", "later");
		span.end();
		const entry = JSON.parse(consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0]);
		expect(entry.context.initial).toBe("value");
	});

	it("idempotent end", () => {
		const span = new Span("test-op", logger);
		span.end();
		span.end();
		span.end();
		const endEntries = consoleSpy.mock.calls.filter((call) =>
			JSON.parse(call[0]).message?.includes("Span ended")
		);
		expect(endEntries.length).toBe(1);
	});
});

describe("extractContextFromRequest", () => {
	it("extracts trace context from headers", () => {
		const request = new Request("https://example.com/test", {
			headers: {
				"x-trace-id": "trace-123",
				"x-span-id": "span-456",
				"x-request-id": "req-789",
			},
		});
		const context = extractContextFromRequest(request);
		expect(context.traceId).toBe("trace-123");
		expect(context.spanId).toBe("span-456");
		expect(context.requestId).toBe("req-789");
	});

	it("returns undefined for missing headers", () => {
		const request = new Request("https://example.com/test");
		const context = extractContextFromRequest(request);
		expect(context.traceId).toBeUndefined();
		expect(context.spanId).toBeUndefined();
		expect(context.requestId).toBeUndefined();
	});
});

describe("injectContextIntoRequest", () => {
	it("adds trace headers to request", () => {
		const request = new Request("https://example.com/test");
		const newRequest = injectContextIntoRequest(request, {
			traceId: "trace-123",
			spanId: "span-456",
			requestId: "req-789",
		});
		expect(newRequest.headers.get("x-trace-id")).toBe("trace-123");
		expect(newRequest.headers.get("x-span-id")).toBe("span-456");
		expect(newRequest.headers.get("x-request-id")).toBe("req-789");
	});

	it("overwrites existing headers", () => {
		const request = new Request("https://example.com/test", {
			headers: {
				"x-trace-id": "old-trace",
			},
		});
		const newRequest = injectContextIntoRequest(request, {
			traceId: "new-trace",
			spanId: "span-456",
			requestId: "req-789",
		});
		expect(newRequest.headers.get("x-trace-id")).toBe("new-trace");
	});
});

describe("Logger edge cases", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	it("handles error without stack trace", () => {
		const logger = new Logger("test", "debug");
		const error = new Error("no stack");
		error.stack = undefined;
		logger.error("test", {}, undefined, error);
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.error.stack).toBeUndefined();
	});

	it("handles error with code property", () => {
		const logger = new Logger("test", "debug");
		const error = new Error("coded error") as Error & { code: string };
		error.code = "ERR_TEST";
		logger.error("test", {}, undefined, error);
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.error.code).toBe("ERR_TEST");
	});

	it("preserves service name across child loggers", () => {
		const logger = new Logger("parent-service", "debug");
		const child = logger.withContext({ runId: "run-1" });
		child.info("child message");
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.service).toBe("parent-service");
	});

	it("handles empty context objects", () => {
		const logger = new Logger("test", "debug");
		logger.info("message", {});
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.context).toEqual({});
	});

	it("handles undefined context gracefully", () => {
		const logger = new Logger("test", "debug");
		logger.info("message", undefined);
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.context).toEqual({});
	});

	it("handles deeply nested context values", () => {
		const logger = new Logger("test", "debug");
		logger.info("message", { nested: { deep: { value: 123 } } });
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.context.nested.deep.value).toBe(123);
	});
});

describe("Span edge cases", () => {
	let logger: Logger;
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logger = new Logger("test", "debug");
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	it("creates root span without parent", () => {
		const span = new Span("root-op", logger);
		expect(span.getTraceId()).toBeDefined();
		expect(span.getSpanId()).toBeDefined();
		span.end();
	});

	it("handles multiple children with same parent", () => {
		const parent = new Span("parent", logger);
		const child1 = parent.child("child1");
		const child2 = parent.child("child2");
		expect(child1.getTraceId()).toBe(parent.getTraceId());
		expect(child2.getTraceId()).toBe(parent.getTraceId());
		expect(child1.getSpanId()).not.toBe(child2.getSpanId());
		parent.end();
		child1.end();
		child2.end();
	});

	it("handles nested grandchildren", () => {
		const grandparent = new Span("grandparent", logger);
		const parent = grandparent.child("parent");
		const child = parent.child("child");
		expect(child.getTraceId()).toBe(grandparent.getTraceId());
		grandparent.end();
		parent.end();
		child.end();
	});

	it("measures actual duration", async () => {
		const span = new Span("timed-op", logger);
		await new Promise((resolve) => setTimeout(resolve, 50));
		span.end();
		const entries = consoleSpy.mock.calls.map((call) => JSON.parse(call[0]));
		const endEntry = entries.find((e) => e.message?.includes("Span ended"));
		expect(endEntry.metrics.durationMs).toBeGreaterThanOrEqual(45);
	});

	it("handles error end without error object", () => {
		const span = new Span("error-op", logger);
		span.end("error");
		const entries = consoleSpy.mock.calls.map((call) => JSON.parse(call[0]));
		const endEntry = entries.find((e) => e.message?.includes("Span ended"));
		expect(endEntry.level).toBe("error");
		expect(endEntry.error).toBeUndefined();
	});

	it("allows setting multiple attributes", () => {
		const span = new Span("multi-attr", logger);
		span.setAttribute("key1", "value1");
		span.setAttribute("key2", 42);
		span.setAttribute("key3", true);
		span.end();
		const entries = consoleSpy.mock.calls.map((call) => JSON.parse(call[0]));
		const endEntry = entries.find((e) => e.message?.includes("Span ended"));
		expect(endEntry.context.key1).toBe("value1");
		expect(endEntry.context.key2).toBe(42);
		expect(endEntry.context.key3).toBe(true);
	});

	it("handles empty event names", () => {
		const span = new Span("empty-event", logger);
		span.addEvent("", { data: "test" });
		span.end();
		const entries = consoleSpy.mock.calls.map((call) => JSON.parse(call[0]));
		const eventEntry = entries.find((e) => e.context?.eventName === "");
		expect(eventEntry).toBeDefined();
	});

	it("preserves initial attributes through end", () => {
		const span = new Span("init-attrs", logger, undefined, { initKey: "initValue" });
		span.setAttribute("addedKey", "addedValue");
		span.end();
		const entries = consoleSpy.mock.calls.map((call) => JSON.parse(call[0]));
		const endEntry = entries.find((e) => e.message?.includes("Span ended"));
		expect(endEntry.context.initKey).toBe("initValue");
		expect(endEntry.context.addedKey).toBe("addedValue");
	});

	it("sanitizes secrets from logged context", () => {
		logger.info("test", { api_key: "super-secret-key-123", normal: "visible" });
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.context.api_key).toBe("[REDACTED]");
		expect(entry.context.normal).toBe("visible");
	});

	it("sanitizes nested secrets in logged context", () => {
		logger.info("test", { config: { password: "hunter2000" }, safe: "ok" });
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.context.config.password).toBe("[REDACTED]");
		expect(entry.context.safe).toBe("ok");
	});

	it("sanitizes secret-looking values in logged context", () => {
		logger.info("test", { myToken: "sk-abcdefghijklmnopqrstuvwxyz" });
		const entry = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(entry.context.myToken).toBe("[REDACTED]");
	});
});
