import { z } from "zod";

// ============================================================================
// Retry Policy Schemas
// ============================================================================

export const RetryPolicySchema = z.object({
	maxAttempts: z.number().int().min(1).max(10).default(3),
	baseDelayMs: z.number().int().min(100).max(60000).default(1000),
	maxDelayMs: z.number().int().min(1000).max(300000).default(60000),
	backoffMultiplier: z.number().min(1).max(10).default(2),
	jitterFactor: z.number().min(0).max(1).default(0.1),
});

export const CircuitBreakerPolicySchema = z.object({
	failureThreshold: z.number().int().min(1).max(20).default(5),
	resetTimeoutMs: z.number().int().min(1000).max(300000).default(30000),
	halfOpenMaxCalls: z.number().int().min(1).max(10).default(3),
});

export const ErrorClassificationSchema = z.object({
	isTransient: z.boolean(),
	isRetryable: z.boolean(),
	errorCategory: z.enum([
		"network",
		"timeout",
		"rate_limit",
		"auth",
		"validation",
		"not_found",
		"conflict",
		"server_error",
		"unknown",
	]),
	shouldSendToDlq: z.boolean(),
	suggestedRetryDelayMs: z.number().int().optional(),
});

export const RetryAttemptSchema = z.object({
	attemptNumber: z.number().int(),
	timestamp: z.string().datetime(),
	errorCode: z.string(),
	errorMessage: z.string(),
	delayMs: z.number().int(),
});

export const RetryStateSchema = z.object({
	errorId: z.string(),
	attempts: z.array(RetryAttemptSchema),
	lastAttemptAt: z.string().datetime(),
	nextRetryAt: z.string().datetime().optional(),
	status: z.enum(["pending", "retrying", "resolved", "dead_letter"]),
});

// ============================================================================
// Types
// ============================================================================

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type CircuitBreakerPolicy = z.infer<typeof CircuitBreakerPolicySchema>;
export type ErrorClassification = z.infer<typeof ErrorClassificationSchema>;
export type RetryAttempt = z.infer<typeof RetryAttemptSchema>;
export type RetryState = z.infer<typeof RetryStateSchema>;

export type RetryableOperation<T> = () => Promise<T>;

export interface RetryContext {
	operationName: string;
	runId?: string;
	sourceId?: string;
	requestId?: string;
}

// ============================================================================
// Error Classification
// ============================================================================

const TRANSIENT_ERROR_PATTERNS = [
	// Network errors
	/ECONNRESET/i,
	/ETIMEDOUT/i,
	/ECONNREFUSED/i,
	/ENOTFOUND/i,
	/EAI_AGAIN/i,
	/Network Error/i,
	/network error/i,
	/fetch failed/i,
	/abort/i,
	/timeout/i,
	// Cloudflare specific
	/Worker exceeded/i,
	/CPU time exceeded/i,
	/Rate limit exceeded/i,
	/Too many requests/i,
	/Service unavailable/i,
	/Bad gateway/i,
	/Gateway timeout/i,
	// D1 specific
	/SQLITE_BUSY/i,
	/database is locked/i,
	// Queue specific
	/Queue is full/i,
	/Message too large/i,
];

const PERMANENT_ERROR_PATTERNS = [
	/Invalid JSON/i,
	/validation failed/i,
	/Schema validation/i,
	/NOT NULL constraint/i,
	/FOREIGN KEY constraint/i,
	/UNIQUE constraint/i,
	/CHECK constraint/i,
	/Permission denied/i,
	/Unauthorized/i,
	/Invalid API key/i,
];

export function classifyError(error: unknown): ErrorClassification {
	const message = error instanceof Error ? error.message : String(error);
	const code = error instanceof Error && "code" in error ? String(error.code) : "";
	const fullText = `${code} ${message}`;

	// Check for permanent errors first (they take precedence)
	for (const pattern of PERMANENT_ERROR_PATTERNS) {
		if (pattern.test(fullText)) {
			return {
				isTransient: false,
				isRetryable: false,
				errorCategory: inferErrorCategory(fullText),
				shouldSendToDlq: true,
			};
		}
	}

	// Check for transient errors
	for (const pattern of TRANSIENT_ERROR_PATTERNS) {
		if (pattern.test(fullText)) {
			return {
				isTransient: true,
				isRetryable: true,
				errorCategory: inferErrorCategory(fullText),
				shouldSendToDlq: false,
				suggestedRetryDelayMs: calculateSuggestedDelay(fullText),
			};
		}
	}

	// Default: treat as transient but retryable
	return {
		isTransient: true,
		isRetryable: true,
		errorCategory: "unknown",
		shouldSendToDlq: false,
		suggestedRetryDelayMs: 5000,
	};
}

function inferErrorCategory(errorText: string): ErrorClassification["errorCategory"] {
	const text = errorText.toLowerCase();

	if (text.includes("timeout") || text.includes("time out")) return "timeout";
	if (text.includes("rate limit") || text.includes("too many")) return "rate_limit";
	if (text.includes("auth") || text.includes("unauthorized") || text.includes("permission"))
		return "auth";
	if (text.includes("validation") || text.includes("invalid")) return "validation";
	if (text.includes("not found") || text.includes("404")) return "not_found";
	if (text.includes("conflict") || text.includes("409")) return "conflict";
	if (text.includes("server error") || text.includes("500") || text.includes("502") || text.includes("503"))
		return "server_error";
	if (text.includes("network") || text.includes("conn") || text.includes("eai")) return "network";

	return "unknown";
}

function calculateSuggestedDelay(errorText: string): number {
	const text = errorText.toLowerCase();

	// Rate limit: suggest longer delay
	if (text.includes("rate limit")) return 60000;
	if (text.includes("too many")) return 30000;

	// Timeout: moderate delay
	if (text.includes("timeout")) return 10000;

	// Database busy: short delay
	if (text.includes("busy") || text.includes("locked")) return 5000;

	// Default
	return 5000;
}

// ============================================================================
// Exponential Backoff Retry
// ============================================================================

export async function withRetry<T>(
	operation: RetryableOperation<T>,
	policy: RetryPolicy,
	context: RetryContext,
	onAttempt?: (attempt: RetryAttempt) => void | Promise<void>,
): Promise<T> {
	const parsedPolicy = RetryPolicySchema.parse(policy);
	let lastError: unknown;

	for (let attempt = 1; attempt <= parsedPolicy.maxAttempts; attempt++) {
		try {
			const result = await operation();

			// Success - if this was a retry, log the recovery
			if (attempt > 1) {
				console.log(`[${context.operationName}] Recovered after ${attempt} attempts`, {
					runId: context.runId,
					requestId: context.requestId,
				});
			}

			return result;
		} catch (error) {
			lastError = error;
			const classification = classifyError(error);

			// Don't retry permanent errors
			if (!classification.isRetryable) {
				console.warn(`[${context.operationName}] Permanent error, not retrying`, {
					error: error instanceof Error ? error.message : String(error),
					category: classification.errorCategory,
				});
				throw error;
			}

			// Calculate delay with exponential backoff and jitter
			const baseDelay =
				classification.suggestedRetryDelayMs ??
				parsedPolicy.baseDelayMs * Math.pow(parsedPolicy.backoffMultiplier, attempt - 1);
			const cappedDelay = Math.min(baseDelay, parsedPolicy.maxDelayMs);
			const jitter = cappedDelay * parsedPolicy.jitterFactor * (Math.random() * 2 - 1);
			const delayMs = Math.max(100, Math.floor(cappedDelay + jitter));

			const attemptRecord: RetryAttempt = {
				attemptNumber: attempt,
				timestamp: new Date().toISOString(),
				errorCode: classification.errorCategory.toUpperCase(),
				errorMessage: error instanceof Error ? error.message : String(error),
				delayMs,
			};

			if (onAttempt) {
				await onAttempt(attemptRecord);
			}

			// Log retry attempt
			console.warn(`[${context.operationName}] Attempt ${attempt} failed, retrying in ${delayMs}ms`, {
				error: error instanceof Error ? error.message : String(error),
				runId: context.runId,
				requestId: context.requestId,
			});

			// Don't delay on the last attempt
			if (attempt < parsedPolicy.maxAttempts) {
				await sleep(delayMs);
			}
		}
	}

	// All attempts exhausted
	console.error(`[${context.operationName}] All ${parsedPolicy.maxAttempts} attempts failed`, {
		lastError: lastError instanceof Error ? lastError.message : String(lastError),
		runId: context.runId,
		requestId: context.requestId,
	});

	throw lastError;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Circuit Breaker
// ============================================================================

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerState {
	state: CircuitState;
	failures: number;
	lastFailureTime: number;
	successes: number;
}

export class CircuitBreaker {
	private state: CircuitBreakerState;
	private policy: CircuitBreakerPolicy;
	private name: string;

	constructor(name: string, policy?: CircuitBreakerPolicy) {
		this.name = name;
		this.policy = CircuitBreakerPolicySchema.parse(policy ?? {});
		this.state = {
			state: "closed",
			failures: 0,
			lastFailureTime: 0,
			successes: 0,
		};
	}

	async execute<T>(operation: RetryableOperation<T>): Promise<T> {
		// Check if we can proceed
		if (this.state.state === "open") {
			if (Date.now() - this.state.lastFailureTime >= this.policy.resetTimeoutMs) {
				// Transition to half-open
				this.state.state = "half-open";
				this.state.successes = 0;
				console.log(`[CircuitBreaker:${this.name}] Transitioned to half-open`);
			} else {
				const remainingMs = this.policy.resetTimeoutMs - (Date.now() - this.state.lastFailureTime);
				throw new CircuitBreakerOpenError(
					`Circuit breaker '${this.name}' is OPEN. Retry after ${remainingMs}ms`,
					remainingMs,
				);
			}
		}

		try {
			const result = await operation();
			this.onSuccess();
			return result;
		} catch (error) {
			this.onFailure();
			throw error;
		}
	}

	private onSuccess(): void {
		if (this.state.state === "half-open") {
			this.state.successes++;
			if (this.state.successes >= this.policy.halfOpenMaxCalls) {
				// Transition back to closed
				console.log(`[CircuitBreaker:${this.name}] Transitioned to closed`);
				this.state = {
					state: "closed",
					failures: 0,
					lastFailureTime: 0,
					successes: 0,
				};
			}
		} else if (this.state.state === "closed") {
			// Reset failures on success in closed state
			this.state.failures = 0;
		}
	}

	private onFailure(): void {
		this.state.failures++;
		this.state.lastFailureTime = Date.now();

		if (this.state.state === "half-open") {
			// Go back to open immediately on failure in half-open
			this.state.state = "open";
			console.warn(`[CircuitBreaker:${this.name}] Failure in half-open, back to open`);
		} else if (this.state.state === "closed" && this.state.failures >= this.policy.failureThreshold) {
			// Transition to open
			this.state.state = "open";
			console.warn(
				`[CircuitBreaker:${this.name}] Transitioned to open after ${this.state.failures} failures`,
			);
		}
	}

	getState(): CircuitBreakerState {
		return { ...this.state };
	}

	isOpen(): boolean {
		return this.state.state === "open";
	}

	isClosed(): boolean {
		return this.state.state === "closed";
	}
}

export class CircuitBreakerOpenError extends Error {
	readonly remainingMs: number;

	constructor(message: string, remainingMs: number) {
		super(message);
		this.name = "CircuitBreakerOpenError";
		this.remainingMs = remainingMs;
	}
}

// ============================================================================
// Dead Letter Queue Handler
// ============================================================================

export interface DlqMessage {
	errorId: string;
	originalPayload: unknown;
	context: RetryContext;
	classification: ErrorClassification;
	attempts: RetryAttempt[];
	failedAt: string;
}

export class DeadLetterQueueHandler {
	private dlq: Queue;
	private maxDlqRetries: number;

	constructor(dlq: Queue, maxDlqRetries = 3) {
		this.dlq = dlq;
		this.maxDlqRetries = maxDlqRetries;
	}

	async sendToDlq(message: DlqMessage): Promise<void> {
		// Add metadata for DLQ processing
		const enrichedMessage = {
			...message,
			_dlqMetadata: {
				sentAt: new Date().toISOString(),
				retryCount: 0,
				maxRetries: this.maxDlqRetries,
			},
		};

		await this.dlq.send(enrichedMessage);

		console.log(`[DLQ] Message sent to dead letter queue`, {
			errorId: message.errorId,
			operation: message.context.operationName,
			category: message.classification.errorCategory,
		});
	}

	async processDlqMessage(
		message: Message<unknown>,
		processor: (msg: DlqMessage) => Promise<void>,
	): Promise<void> {
		const body = message.body as DlqMessage & {
			_dlqMetadata?: {
				sentAt: string;
				retryCount: number;
				maxRetries: number;
			};
		};

		const metadata = body._dlqMetadata ?? { sentAt: new Date().toISOString(), retryCount: 0, maxRetries: this.maxDlqRetries };

		try {
			await processor(body);
			message.ack();
			console.log(`[DLQ] Message processed successfully`, {
				errorId: body.errorId,
				operation: body.context.operationName,
			});
		} catch (error) {
			metadata.retryCount++;

			if (metadata.retryCount >= metadata.maxRetries) {
				// Max retries reached, acknowledge to prevent infinite loop
				console.error(`[DLQ] Max retries reached, acknowledging message`, {
					errorId: body.errorId,
					retryCount: metadata.retryCount,
				});
				message.ack();
			} else {
				// Retry with delay
				console.warn(`[DLQ] Processing failed, will retry`, {
					errorId: body.errorId,
					retryCount: metadata.retryCount,
					error: error instanceof Error ? error.message : String(error),
				});
				message.retry();
			}
		}
	}
}

// ============================================================================
// Idempotency Helpers
// ============================================================================

/**
 * Generate a deterministic idempotency key from operation context.
 * This ensures the same operation produces the same key.
 */
export function generateIdempotencyKey(context: {
	operation: string;
	runId?: string;
	entityId?: string;
	requestId?: string;
	payload?: unknown;
}): string {
	const components = [
		context.operation,
		context.runId ?? "",
		context.entityId ?? "",
		context.requestId ?? "",
		context.payload ? JSON.stringify(context.payload) : "",
	];

	const key = components.join("::");

	// Simple hash for idempotency key
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		const char = key.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32bit integer
	}

	return `idem_${Math.abs(hash).toString(36)}`;
}

/**
 * Check if an error indicates a duplicate/conflict that can be treated as success.
 */
export function isDuplicateError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const patterns = [
		/UNIQUE constraint failed/i,
		/duplicate key/i,
		/already exists/i,
		/ON CONFLICT/i,
	];

	return patterns.some((p) => p.test(message));
}

// ============================================================================
// Default Policies
// ============================================================================

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 60000,
	backoffMultiplier: 2,
	jitterFactor: 0.1,
};

export const D1_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 5,
	baseDelayMs: 500,
	maxDelayMs: 30000,
	backoffMultiplier: 2,
	jitterFactor: 0.2,
};

export const R2_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	backoffMultiplier: 2,
	jitterFactor: 0.1,
};

export const VECTORIZE_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	backoffMultiplier: 2,
	jitterFactor: 0.1,
};

export const DEFAULT_CIRCUIT_BREAKER_POLICY: CircuitBreakerPolicy = {
	failureThreshold: 5,
	resetTimeoutMs: 30000,
	halfOpenMaxCalls: 3,
};
