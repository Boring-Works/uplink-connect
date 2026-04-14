import type { Env } from "../types";
import { sanitizeObject } from "@uplink/contracts";

/**
 * Structured Logging with OpenTelemetry-style spans
 *
 * For a daily-use production tool, you need:
 * - Request tracing across workers
 * - Performance timing
 * - Contextual fields for debugging
 * - Log levels that mean something
 * - Automatic secret redaction in logged context
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogContext {
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	runId?: string;
	sourceId?: string;
	requestId?: string;
	userId?: string;
	[key: string]: unknown;
}

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	service: string;
	context: LogContext;
	metrics?: {
		durationMs?: number;
		retryCount?: number;
		batchSize?: number;
		[key: string]: number | undefined;
	};
	error?: {
		name: string;
		message: string;
		stack?: string;
		code?: string;
	};
}

export class Logger {
	private service: string;
	private defaultContext: LogContext;
	private minLevel: LogLevel;

	private static LEVEL_PRIORITY: Record<LogLevel, number> = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3,
		fatal: 4,
	};

	constructor(service: string, minLevel: LogLevel = "info", defaultContext: LogContext = {}) {
		this.service = service;
		this.minLevel = minLevel;
		this.defaultContext = defaultContext;
	}

	withContext(context: LogContext): Logger {
		return new Logger(this.service, this.minLevel, {
			...this.defaultContext,
			...context,
		});
	}

	debug(message: string, context?: Partial<LogContext>, metrics?: LogEntry["metrics"]): void {
		this.log("debug", message, context, metrics);
	}

	info(message: string, context?: Partial<LogContext>, metrics?: LogEntry["metrics"]): void {
		this.log("info", message, context, metrics);
	}

	warn(message: string, context?: Partial<LogContext>, metrics?: LogEntry["metrics"], error?: Error): void {
		this.log("warn", message, context, metrics, error);
	}

	error(message: string, context?: Partial<LogContext>, metrics?: LogEntry["metrics"], error?: Error): void {
		this.log("error", message, context, metrics, error);
	}

	fatal(message: string, context?: Partial<LogContext>, metrics?: LogEntry["metrics"], error?: Error): void {
		this.log("fatal", message, context, metrics, error);
	}

	private log(
		level: LogLevel,
		message: string,
		context?: Partial<LogContext>,
		metrics?: LogEntry["metrics"],
		error?: Error
	): void {
		if (Logger.LEVEL_PRIORITY[level] < Logger.LEVEL_PRIORITY[this.minLevel]) {
			return;
		}

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			service: this.service,
			context: sanitizeObject({
				...this.defaultContext,
				...context,
			}),
			metrics,
		};

		if (error) {
			entry.error = {
				name: error.name,
				message: error.message,
				stack: error.stack,
				code: (error as { code?: string }).code,
			};
		}

		// In production, you'd send this to a log aggregator
		// For now, structured console output
		console.log(JSON.stringify(entry));
	}
}

/**
 * Span tracking for request tracing
 */
export class Span {
	private traceId: string;
	private spanId: string;
	private parentSpanId?: string;
	private name: string;
	private startTime: number;
	private logger: Logger;
	private attributes: Record<string, unknown>;
	private ended = false;

	constructor(
		name: string,
		logger: Logger,
		parent?: Span,
		attributes: Record<string, unknown> = {}
	) {
		this.name = name;
		this.traceId = parent?.traceId ?? generateTraceId();
		this.spanId = generateSpanId();
		this.parentSpanId = parent?.spanId;
		this.startTime = performance.now();
		this.logger = logger.withContext({
			traceId: this.traceId,
			spanId: this.spanId,
			parentSpanId: this.parentSpanId,
			...attributes,
		});
		this.attributes = attributes;

		this.logger.debug(`Span started: ${name}`, { spanName: name });
	}

	setAttribute(key: string, value: unknown): void {
		this.attributes[key] = value;
	}

	addEvent(name: string, attributes?: Record<string, unknown>): void {
		this.logger.debug(`Event: ${name}`, { eventName: name, ...attributes });
	}

	end(status: "ok" | "error" = "ok", error?: Error): void {
		if (this.ended) return;
		this.ended = true;

		const durationMs = performance.now() - this.startTime;
		const level = status === "error" ? "error" : "debug";

		// Use the logger's public methods instead of private log
		if (status === "error") {
			this.logger.error(`Span ended: ${this.name} (${status})`, { spanName: this.name, spanStatus: status, ...this.attributes }, { durationMs }, error);
		} else {
			this.logger.debug(`Span ended: ${this.name} (${status})`, { spanName: this.name, spanStatus: status, ...this.attributes }, { durationMs });
		}
	}

	child(name: string, attributes?: Record<string, unknown>): Span {
		return new Span(name, this.logger, this, attributes);
	}

	getTraceId(): string {
		return this.traceId;
	}

	getSpanId(): string {
		return this.spanId;
	}
}

/**
 * Request context for tracing across workers
 */
export interface RequestContext {
	traceId: string;
	spanId: string;
	requestId: string;
	sourceId?: string;
	runId?: string;
}

export function extractContextFromRequest(request: Request): Partial<RequestContext> {
	return {
		traceId: request.headers.get("x-trace-id") ?? undefined,
		spanId: request.headers.get("x-span-id") ?? undefined,
		requestId: request.headers.get("x-request-id") ?? undefined,
	};
}

export function injectContextIntoRequest(
	request: Request,
	context: RequestContext
): Request {
	const newRequest = new Request(request);
	newRequest.headers.set("x-trace-id", context.traceId);
	newRequest.headers.set("x-span-id", context.spanId);
	newRequest.headers.set("x-request-id", context.requestId);
	return newRequest;
}

function generateTraceId(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

function generateSpanId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// Global logger instances per service
export const loggers = {
	edge: new Logger("uplink-edge"),
	core: new Logger("uplink-core"),
	browser: new Logger("uplink-browser"),
	ops: new Logger("uplink-ops"),
};
