import { z } from "zod";

export const SOURCE_TYPES = ["api", "webhook", "email", "file", "browser", "manual", "stream", "nws"] as const;

export const SourceTypeSchema = z.enum(SOURCE_TYPES);

export const SourceStatusSchema = z.enum(["active", "paused", "disabled"]);

export const ALERT_TYPES = ["source_failure_rate", "queue_lag", "run_stuck", "lease_expired"] as const;
export const ALERT_SEVERITIES = ["warning", "critical"] as const;

export const AlertTypeSchema = z.enum(ALERT_TYPES);
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);

export const AlertRuleSchema = z.object({
	alertType: AlertTypeSchema,
	severity: AlertSeveritySchema,
	threshold: z.number().min(0),
	windowSeconds: z.number().int().min(0),
	enabled: z.boolean().default(true),
});

export const NotificationProviderTypeSchema = z.enum([
	"webhook",
	"slack",
	"discord",
	"teams",
	"pagerduty",
	"opsgenie",
	"email",
	"custom",
]);

export const NotificationProviderSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("webhook"),
		url: z.string().url(),
		headers: z.record(z.string()).optional(),
	}),
	z.object({
		type: z.literal("slack"),
		webhookUrl: z.string().url(),
		channel: z.string().optional(),
		username: z.string().optional(),
	}),
	z.object({
		type: z.literal("discord"),
		webhookUrl: z.string().url(),
	}),
	z.object({
		type: z.literal("teams"),
		webhookUrl: z.string().url(),
	}),
	z.object({
		type: z.literal("pagerduty"),
		routingKey: z.string().min(1),
		severity: z.enum(["critical", "error", "warning", "info"]).optional(),
	}),
	z.object({
		type: z.literal("opsgenie"),
		apiKey: z.string().min(1),
		responders: z.array(z.string()).optional(),
	}),
	z.object({
		type: z.literal("email"),
		to: z.array(z.string().email()).min(1),
		from: z.string().email().optional(),
		subjectTemplate: z.string().optional(),
	}),
	z.object({
		type: z.literal("custom"),
		url: z.string().url(),
		method: z.enum(["GET", "POST", "PUT", "PATCH"]).default("POST"),
		headers: z.record(z.string()).optional(),
		bodyTemplate: z.string().optional(),
	}),
]);

export const NotificationRouteSchema = z.object({
	providerId: z.string().min(1),
	severityFilter: z.array(AlertSeveritySchema).optional(),
	alertTypeFilter: z.array(AlertTypeSchema).optional(),
	sourceIdFilter: z.array(z.string().min(1)).optional(),
	enabled: z.boolean().default(true),
});

export const AlertConfigurationSchema = z.object({
	alertRules: z.array(AlertRuleSchema).default([]),
	providers: z.array(NotificationProviderSchema).default([]),
	routes: z.array(NotificationRouteSchema).default([]),
	// Legacy fields preserved for backwards compatibility
	notificationChannels: z.object({
		webhook: z.string().url().optional(),
		email: z.array(z.string().email()).optional(),
	}).optional(),
});

export const SourcePolicySchema = z.object({
	minIntervalSeconds: z.number().int().min(1).default(60),
	leaseTtlSeconds: z.number().int().min(30).max(3600).default(300),
	maxRecordsPerRun: z.number().int().min(1).max(10000).default(1000),
	retryLimit: z.number().int().min(0).max(10).default(3),
	timeoutSeconds: z.number().int().min(5).max(600).default(60),
	alertConfiguration: AlertConfigurationSchema.optional(),
});

export const WebhookSecuritySchema = z.object({
	secret: z.string().min(1).optional(),
	signatureHeader: z.string().min(1).optional(),
	signatureAlgorithm: z.enum(["hmac-sha256", "hmac-sha512"]).default("hmac-sha256"),
}).optional();

export const SourceConfigSchema = z.object({
	sourceId: z.string().min(1),
	name: z.string().min(1),
	type: SourceTypeSchema,
	status: SourceStatusSchema.default("active"),
	adapterType: z.string().min(1),
	endpointUrl: z.string().url().optional(),
	requestMethod: z.enum(["GET", "POST"]).default("GET"),
	requestHeaders: z.record(z.string(), z.string()).default({}),
	requestBody: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).default({}),
	policy: SourcePolicySchema,
	webhookSecurity: WebhookSecuritySchema,
});

export const SourceTriggerRequestSchema = z.object({
	triggeredBy: z.string().min(1).default("system"),
	reason: z.string().min(1).optional(),
	force: z.boolean().default(false),
});

export const CollectionWorkflowParamsSchema = z.object({
	sourceId: z.string().min(1),
	leaseToken: z.string().min(1),
	triggeredBy: z.string().min(1),
	reason: z.string().min(1).optional(),
	force: z.boolean().default(false),
});

export const RetentionWorkflowParamsSchema = z.object({
	retentionDays: z.number().int().min(1).max(3650).default(90),
	dryRun: z.boolean().default(false),
	triggeredBy: z.string().min(1).default("system"),
	batchSize: z.number().int().min(1).max(5000).default(1000),
});

export const IngestRecordSchema = z.object({
	externalId: z.string().min(1).optional(),
	contentHash: z.string().min(16),
	rawPayload: z.unknown(),
	suggestedEntityType: z.string().min(1).optional(),
	observedAt: z.string().datetime().optional(),
});

export const IngestEnvelopeSchema = z.object({
	schemaVersion: z.literal("1.0"),
	ingestId: z.string().min(8),
	sourceId: z.string().min(1),
	sourceName: z.string().min(1),
	sourceType: SourceTypeSchema,
	collectedAt: z.string().datetime(),
	records: z.array(IngestRecordSchema).min(1),
	hasMore: z.boolean().default(false),
	nextCursor: z.string().min(1).optional(),
	traceId: z.string().min(1).optional(),
	collectionDurationMs: z.number().int().nonnegative().optional(),
	externalRequestId: z.string().min(1).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const IngestQueueMessageSchema = z.object({
	envelope: IngestEnvelopeSchema,
	receivedAt: z.string().datetime(),
	requestId: z.string().min(1).optional(),
});

// Vectorize search schemas
export const EntitySearchRequestSchema = z.object({
	query: z.string().min(1).max(2000),
	topK: z.number().int().min(1).max(100).optional(),
	filter: z.record(z.string(), z.unknown()).optional(),
});

export const EntitySearchResultSchema = z.object({
	entityId: z.string(),
	score: z.number(),
	metadata: z.object({
		entityId: z.string(),
		sourceId: z.string(),
		entityType: z.string(),
		observedAt: z.string(),
		contentHash: z.string(),
	}),
});

export const EntitySearchResponseSchema = z.object({
	query: z.string(),
	results: z.array(EntitySearchResultSchema),
	total: z.number().int(),
});

export type SourceType = z.infer<typeof SourceTypeSchema>;
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export type AlertType = z.infer<typeof AlertTypeSchema>;
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;
export type AlertRule = z.infer<typeof AlertRuleSchema>;
export type AlertConfiguration = z.infer<typeof AlertConfigurationSchema>;
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;
export type WebhookSecurity = z.infer<typeof WebhookSecuritySchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type SourceTriggerRequest = z.infer<typeof SourceTriggerRequestSchema>;
export type CollectionWorkflowParams = z.infer<typeof CollectionWorkflowParamsSchema>;
export type RetentionWorkflowParams = z.infer<typeof RetentionWorkflowParamsSchema>;
export type IngestRecord = z.infer<typeof IngestRecordSchema>;
export type IngestEnvelope = z.infer<typeof IngestEnvelopeSchema>;
export type IngestQueueMessage = z.infer<typeof IngestQueueMessageSchema>;
export type EntitySearchRequest = z.infer<typeof EntitySearchRequestSchema>;
export type EntitySearchResult = z.infer<typeof EntitySearchResultSchema>;
export type EntitySearchResponse = z.infer<typeof EntitySearchResponseSchema>;

export function toIsoNow(): string {
	return new Date().toISOString();
}

export function createIngestQueueMessage(
	envelope: IngestEnvelope,
	options?: { requestId?: string },
): IngestQueueMessage {
	return {
		envelope,
		receivedAt: toIsoNow(),
		requestId: options?.requestId,
	};
}

export function buildRawArtifactKey(envelope: IngestEnvelope): string {
	const day = envelope.collectedAt.slice(0, 10);
	return `raw/${envelope.sourceId}/${day}/${envelope.ingestId}.json`;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Does NOT leak length information.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const bufA = encoder.encode(a);
	const bufB = encoder.encode(b);
	const len = Math.max(bufA.length, bufB.length);
	const x = new Uint8Array(len);
	const y = new Uint8Array(len);
	x.set(bufA);
	y.set(bufB);
	let diff = 0;
	for (let i = 0; i < len; i++) {
		diff |= x[i] ^ y[i];
	}
	return diff === 0 && bufA.length === bufB.length;
}

/**
 * Verify webhook HMAC signature
 * Supports HMAC-SHA256 and HMAC-SHA512
 */
export async function verifyWebhookSignature(
	payload: string,
	signature: string,
	secret: string,
	algorithm: "hmac-sha256" | "hmac-sha512" = "hmac-sha256",
): Promise<boolean> {
	const algo = algorithm === "hmac-sha512" ? "SHA-512" : "SHA-256";
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: algo },
		false,
		["sign"],
	);
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return timingSafeEqual(signature, expectedSignature);
}

/**
 * Generate webhook signature for testing/outbound webhooks
 */
export async function generateWebhookSignature(
	payload: string,
	secret: string,
	algorithm: "hmac-sha256" | "hmac-sha512" = "hmac-sha256",
): Promise<string> {
	const algo = algorithm === "hmac-sha512" ? "SHA-512" : "SHA-256";
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: algo },
		false,
		["sign"],
	);
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	return Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Analytics event schemas for Pipelines sink
export const AnalyticsEventTypeSchema = z.enum([
	"ingest.received",
	"ingest.persisted",
	"ingest.normalized",
	"entity.created",
	"entity.updated",
]);

export const BaseAnalyticsEventSchema = z.object({
	eventType: AnalyticsEventTypeSchema,
	timestamp: z.string().datetime(),
	traceId: z.string().optional(),
	sourceId: z.string().min(1),
	sourceType: z.string().min(1),
	runId: z.string().min(1),
});

export const IngestReceivedEventSchema = BaseAnalyticsEventSchema.extend({
	eventType: z.literal("ingest.received"),
	recordCount: z.number().int().nonnegative(),
	collectedAt: z.string().datetime(),
	receivedAt: z.string().datetime(),
	triggeredBy: z.string().optional(),
	replayOfRunId: z.string().optional(),
});

export const IngestPersistedEventSchema = BaseAnalyticsEventSchema.extend({
	eventType: z.literal("ingest.persisted"),
	artifactKey: z.string().min(1),
	sizeBytes: z.number().int().nonnegative(),
	recordCount: z.number().int().nonnegative(),
});

export const IngestNormalizedEventSchema = BaseAnalyticsEventSchema.extend({
	eventType: z.literal("ingest.normalized"),
	normalizedCount: z.number().int().nonnegative(),
	durationMs: z.number().int().nonnegative().optional(),
});

export const EntityCreatedEventSchema = BaseAnalyticsEventSchema.extend({
	eventType: z.literal("entity.created"),
	entityId: z.string().min(1),
	externalId: z.string().optional(),
	contentHash: z.string().min(16),
	observedAt: z.string().datetime(),
});

export const EntityUpdatedEventSchema = BaseAnalyticsEventSchema.extend({
	eventType: z.literal("entity.updated"),
	entityId: z.string().min(1),
	externalId: z.string().optional(),
	contentHash: z.string().min(16),
	observedAt: z.string().datetime(),
	previousContentHash: z.string().min(16).optional(),
});

export const AnalyticsEventSchema = z.discriminatedUnion("eventType", [
	IngestReceivedEventSchema,
	IngestPersistedEventSchema,
	IngestNormalizedEventSchema,
	EntityCreatedEventSchema,
	EntityUpdatedEventSchema,
]);

export type AnalyticsEventType = z.infer<typeof AnalyticsEventTypeSchema>;
export type BaseAnalyticsEvent = z.infer<typeof BaseAnalyticsEventSchema>;
export type IngestReceivedEvent = z.infer<typeof IngestReceivedEventSchema>;
export type IngestPersistedEvent = z.infer<typeof IngestPersistedEventSchema>;
export type IngestNormalizedEvent = z.infer<typeof IngestNormalizedEventSchema>;
export type EntityCreatedEvent = z.infer<typeof EntityCreatedEventSchema>;
export type EntityUpdatedEvent = z.infer<typeof EntityUpdatedEventSchema>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

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

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type CircuitBreakerPolicy = z.infer<typeof CircuitBreakerPolicySchema>;
export type ErrorClassification = z.infer<typeof ErrorClassificationSchema>;
export type RetryAttempt = z.infer<typeof RetryAttemptSchema>;
export type RetryState = z.infer<typeof RetryStateSchema>;

// ============================================================================
// Error Recovery Schemas
// ============================================================================

export const ErrorStatusSchema = z.enum(["pending", "retrying", "resolved", "dead_letter"]);

export const ErrorFilterSchema = z.object({
	status: ErrorStatusSchema.optional(),
	sourceId: z.string().optional(),
	phase: z.string().optional(),
	errorCategory: ErrorClassificationSchema.shape.errorCategory.optional(),
	fromDate: z.string().datetime().optional(),
	toDate: z.string().datetime().optional(),
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().min(0).default(0),
});

export const ErrorRetryRequestSchema = z.object({
	force: z.boolean().default(false),
	triggeredBy: z.string().min(1).default("manual"),
});

export const ErrorRetryResponseSchema = z.object({
	success: z.boolean(),
	errorId: z.string(),
	newStatus: ErrorStatusSchema,
	message: z.string(),
	retryAttemptId: z.string().optional(),
});

export const ErrorListItemSchema = z.object({
	errorId: z.string(),
	runId: z.string().nullable(),
	sourceId: z.string().nullable(),
	phase: z.string(),
	errorCode: z.string(),
	errorMessage: z.string(),
	status: ErrorStatusSchema,
	retryCount: z.number().int(),
	occurrenceCount: z.number().int().optional(),
	lastRetryAt: z.string().datetime().nullable(),
	createdAt: z.string().datetime(),
	payloadPreview: z.string().optional(),
});

export const ErrorListResponseSchema = z.object({
	errors: z.array(ErrorListItemSchema),
	total: z.number().int(),
	limit: z.number().int(),
	offset: z.number().int(),
	hasMore: z.boolean(),
});

export type ErrorStatus = z.infer<typeof ErrorStatusSchema>;
export type ErrorFilter = z.infer<typeof ErrorFilterSchema>;
export type ErrorRetryRequest = z.infer<typeof ErrorRetryRequestSchema>;
export type ErrorRetryResponse = z.infer<typeof ErrorRetryResponseSchema>;
export type ErrorListItem = z.infer<typeof ErrorListItemSchema>;
export type ErrorListResponse = z.infer<typeof ErrorListResponseSchema>;

// ============================================================================
// Safe JSON Utilities (from promptfoo patterns)
// ============================================================================

/**
 * Safely stringify a value to JSON, handling circular references, BigInt, and functions.
 * Returns a fallback string if serialization fails entirely.
 */
export function safeJsonStringify(value: unknown, pretty = false): string {
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(
			value,
			(_key, val) => {
				if (typeof val === "bigint") {
					return val.toString();
				}
				if (typeof val === "function") {
					return "[Function]";
				}
				if (val instanceof Error) {
					return {
						name: val.name,
						message: val.message,
						stack: val.stack,
					};
				}
				if (val && typeof val === "object") {
					if (seen.has(val)) {
						return "[Circular]";
					}
					seen.add(val);
				}
				return val;
			},
			pretty ? 2 : undefined,
		);
	} catch {
		return "[Unserializable]";
	}
}

/**
 * Safely parse JSON without throwing.
 */
export function safeJsonParse<T = unknown>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/**
 * Extract all JSON objects from a string (useful for parsing LLM outputs).
 */
export function extractJsonObjects(text: string): unknown[] {
	const objects: unknown[] = [];
	// Match JSON objects
	const objectPattern = /\{[\s\S]*?\}/g;
	const matches = text.match(objectPattern) ?? [];
	for (const match of matches) {
		try {
			const parsed = JSON.parse(match);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				objects.push(parsed);
			}
		} catch {
			// ignore invalid JSON fragments
		}
	}
	return objects;
}

/**
 * Extract the first valid JSON object from a string.
 */
export function extractFirstJsonObject(text: string): unknown | undefined {
	const objects = extractJsonObjects(text);
	return objects[0];
}

// ============================================================================
// Secret Sanitization (from promptfoo patterns — expanded)
// ============================================================================

const REDACTED = "[REDACTED]";
const SANITIZE_MAX_DEPTH = 4;
const DUMMY_BASE = "http://placeholder";

/**
 * Set of field names that should be redacted (case-insensitive, with hyphens/underscores normalized)
 * Note: Keys are stored in their normalized form (lowercase, no hyphens/underscores)
 */
const SECRET_FIELD_NAMES = new Set([
	// Password variants
	"password",
	"passwd",
	"pwd",
	// Secret variants
	"secret",
	"secrets",
	"secretkey",
	"credentials",
	// API keys and tokens
	"apikey",
	"apisecret",
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"bearertoken",
	"authtoken",
	"clientsecret",
	"webhooksecret",
	"authorization",
	"auth",
	"bearer",
	"apikeyenvar",
	// Header-specific patterns (normalized: hyphens removed)
	"xapikey", // x-api-key
	"xauthtoken", // x-auth-token
	"xaccesstoken", // x-access-token
	"xauth", // x-auth
	"xsecret", // x-secret
	"xcsrftoken", // x-csrf-token
	"xsessiondata", // x-session-data
	"csrftoken", // csrf-token
	"sessionid", // session-id
	"session", // session
	"cookie",
	"setcookie", // set-cookie
	// Certificate and encryption
	"certificatepassword",
	"keystorepassword",
	"pfxpassword",
	"privatekey",
	"certkey",
	"encryptionkey",
	"signingkey",
	"signature",
	"sig",
	"passphrase",
	"certificatecontent",
	"keystorecontent",
	"pfx",
	"pfxcontent",
	"keycontent",
	"certcontent",
	// Uplink-specific
	"ingestapikey",
	"coreinternalkey",
	"browserapikey",
	"opsapikey",
	"dashboardpassword",
	"slackwebhookurl",
	"webhookurl",
	"webhookurl",
	"routingkey",
]);

function normalizeFieldName(fieldName: string): string {
	return fieldName.toLowerCase().replace(/[-_]/g, "");
}

function isSecretField(fieldName: string): boolean {
	return SECRET_FIELD_NAMES.has(normalizeFieldName(fieldName));
}

/**
 * Check if a value looks like a secret based on common patterns.
 */
export function looksLikeSecret(value: string): boolean {
	if (typeof value !== "string") return false;

	// OpenAI API keys (sk-...)
	if (/^sk-[a-zA-Z0-9-_]{20,}/.test(value)) return true;
	// OpenAI project keys (sk-proj-...)
	if (/^sk-proj-[a-zA-Z0-9-_]{20,}/.test(value)) return true;
	// Anthropic keys (sk-ant-...)
	if (/^sk-ant-[a-zA-Z0-9-_]{20,}/.test(value)) return true;
	// Generic API key patterns (key-...)
	if (/^key-[a-zA-Z0-9]{20,}/.test(value)) return true;
	// Bearer tokens
	if (/^Bearer\s+.{20,}/i.test(value)) return true;
	// Basic auth
	if (/^Basic\s+.{20,}/i.test(value)) return true;
	// Long base64-like strings (likely tokens/keys) - 64+ chars
	if (/^[a-zA-Z0-9+/=_-]{64,}$/.test(value)) return true;
	// AWS-style access keys (AKIA...)
	if (/^AKIA[A-Z0-9]{16}/.test(value)) return true;
	// Google API keys (AIza...)
	if (/^AIza[a-zA-Z0-9_-]{35}/.test(value)) return true;

	return false;
}

function isClassInstance(obj: object): boolean {
	const proto = Object.getPrototypeOf(obj);
	if (!proto || proto === Object.prototype) return false;
	return Object.getOwnPropertyNames(proto).some(
		(prop) => prop !== "constructor" && typeof (proto as Record<string, unknown>)[prop] === "function",
	);
}

function redactValue(value: string): string {
	if (value.length <= 8) return "***";
	return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function sanitizeJsonString(str: string, depth: number, maxDepth: number): string {
	try {
		const parsed = JSON.parse(str);
		if (parsed && typeof parsed === "object") {
			const sanitized = recursiveSanitize(parsed, depth, maxDepth);
			return safeJsonStringify(sanitized);
		}
	} catch {
		if (looksLikeSecret(str)) return REDACTED;
	}
	return str;
}

function sanitizePlainObject(obj: Record<string, unknown>, depth: number, maxDepth: number): unknown {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (key === "url" && typeof value === "string") {
			sanitized[key] = sanitizeUrl(value);
		} else if (isSecretField(key)) {
			sanitized[key] = REDACTED;
		} else if (typeof value === "string" && looksLikeSecret(value)) {
			sanitized[key] = REDACTED;
		} else {
			sanitized[key] = recursiveSanitize(value, depth + 1, maxDepth);
		}
	}
	return sanitized;
}

function recursiveSanitize(obj: unknown, depth = 0, maxDepth = SANITIZE_MAX_DEPTH): unknown {
	if (typeof obj === "function") {
		return `[Function] ${obj.name}`;
	}
	if (typeof obj === "string") {
		return sanitizeJsonString(obj, depth, maxDepth);
	}
	if (obj === null || obj === undefined || typeof obj !== "object") {
		return obj;
	}
	if (depth > maxDepth) {
		return "[...]";
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => recursiveSanitize(item, depth + 1, maxDepth));
	}
	if (isClassInstance(obj)) {
		const constructorName = (obj.constructor?.name) || "Object";
		return `[${constructorName} Instance]`;
	}
	return sanitizePlainObject(obj as Record<string, unknown>, depth, maxDepth);
}

/**
 * Generic function to sanitize any object by removing or redacting sensitive information.
 * @param obj - The object to sanitize
 * @param options - Optional configuration
 * @returns A sanitized copy of the object with secrets redacted
 */
export function sanitizeObject<T>(
	obj: T,
	options: {
		context?: string;
		throwOnError?: boolean;
		maxDepth?: number;
	} = {},
): T {
	const { context = "object", throwOnError = false, maxDepth = SANITIZE_MAX_DEPTH } = options;

	try {
		if (obj === null || obj === undefined) return obj;
		if (typeof obj === "string") return sanitizeJsonString(obj, 0, maxDepth) as unknown as T;
		if (typeof obj !== "object") return obj;

		// Handle circular references via safeJsonStringify + parse
		const safeObj = safeJsonParse(safeJsonStringify(obj)) ?? obj;
		return recursiveSanitize(safeObj, 0, maxDepth) as T;
	} catch (error) {
		if (throwOnError) throw error;
		console.error(`Error sanitizing ${context}:`, error);
		return obj;
	}
}

// Legacy exports for backward compatibility
export const sanitizeBody = sanitizeObject;
export const sanitizeHeaders = sanitizeObject;
export const sanitizeQueryParams = sanitizeObject;

/**
 * Sanitize a URL by redacting any username:password credentials
 * and sensitive query parameters.
 */
export function sanitizeUrl(url: string): string {
	try {
		if (typeof url !== "string" || !url.trim()) return url;

		// Skip template URLs (e.g., {{ variable }})
		if (url.includes("{{") && url.includes("}}")) return url;

		// Handle path-only URLs
		const isPathOnly = url.startsWith("/") && !url.startsWith("//");
		const parsedUrl = isPathOnly ? new URL(url, DUMMY_BASE) : new URL(url);
		const sanitizedUrl = new URL(parsedUrl.href);

		if (sanitizedUrl.username || sanitizedUrl.password) {
			sanitizedUrl.username = "***";
			sanitizedUrl.password = "***";
		}

		// Sanitize sensitive query parameters
		const sensitiveParams =
			/(api[_-]?key|token|password|secret|signature|sig|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization)/i;

		for (const key of Array.from(sanitizedUrl.searchParams.keys())) {
			if (sensitiveParams.test(key)) {
				sanitizedUrl.searchParams.set(key, REDACTED);
			}
		}

		if (isPathOnly) {
			return sanitizedUrl.pathname + sanitizedUrl.search + sanitizedUrl.hash;
		}
		return sanitizedUrl.toString();
	} catch (error) {
		console.warn(`Failed to sanitize URL ${url}:`, error);
		return url;
	}
}

// ============================================================================
// Fetch Error Classification (from promptfoo patterns)
// ============================================================================

const NON_TRANSIENT_HTTP_STATUSES = new Set([
	400, // Bad Request
	401, // Unauthorized
	403, // Forbidden
	404, // Not Found
	405, // Method Not Allowed
	406, // Not Acceptable
	409, // Conflict
	410, // Gone
	411, // Length Required
	412, // Precondition Failed
	413, // Payload Too Large
	414, // URI Too Long
	415, // Unsupported Media Type
	416, // Range Not Satisfiable
	422, // Unprocessable Entity
	426, // Upgrade Required
	501, // Not Implemented
]);

const TRANSIENT_HTTP_STATUSES = new Set([
	408, // Request Timeout
	429, // Too Many Requests
	500, // Internal Server Error
	502, // Bad Gateway
	503, // Service Unavailable
	504, // Gateway Timeout
]);

/**
 * Check if an HTTP status code indicates a non-transient (should not retry) error.
 */
export function isNonTransientHttpStatus(status: number): boolean {
	return NON_TRANSIENT_HTTP_STATUSES.has(status);
}

/**
 * Check if an HTTP status code indicates a transient (retryable) error.
 */
export function isTransientHttpStatus(status: number): boolean {
	return TRANSIENT_HTTP_STATUSES.has(status);
}

/**
 * Classify an HTTP response as transient or non-transient.
 * Returns undefined if the status is ambiguous.
 */
export function classifyHttpStatus(status: number): "transient" | "non-transient" | undefined {
	if (isNonTransientHttpStatus(status)) return "non-transient";
	if (isTransientHttpStatus(status)) return "transient";
	return undefined;
}

/**
 * Check if an error looks like a transient network/connection error.
 */
export function isTransientConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	const patterns = [
		"econnreset",
		"etimedout",
		"econnrefused",
		"enotfound",
		"eai_again",
		"network error",
		"fetch failed",
		"abort",
		"timeout",
		"worker exceeded",
		"cpu time exceeded",
		"bad gateway",
		"gateway timeout",
		"service unavailable",
	];
	return patterns.some((p) => message.includes(p));
}

/**
 * Determine whether an HTTP error should be retried.
 * Combines status code analysis with connection error heuristics.
 */
export function shouldRetryHttpError(status: number, error?: unknown): boolean {
	if (isNonTransientHttpStatus(status)) return false;
	if (isTransientHttpStatus(status)) return true;
	if (error && isTransientConnectionError(error)) return true;
	// Default: retry unknown statuses once
	return true;
}

// ============================================================================
// Rate Limit Header Parsing (from promptfoo patterns)
// ============================================================================

export interface ParsedRateLimitHeaders {
	remainingRequests?: number;
	remainingTokens?: number;
	limitRequests?: number;
	limitTokens?: number;
	resetAt?: number; // Absolute Unix timestamp in milliseconds
	retryAfterMs?: number; // Relative duration in milliseconds
}

const OPENAI_HEADERS = {
	remainingRequests: "x-ratelimit-remaining-requests",
	remainingTokens: "x-ratelimit-remaining-tokens",
	limitRequests: "x-ratelimit-limit-requests",
	limitTokens: "x-ratelimit-limit-tokens",
	resetRequests: "x-ratelimit-reset-requests",
	resetTokens: "x-ratelimit-reset-tokens",
} as const;

const ANTHROPIC_HEADERS = {
	remainingRequests: "anthropic-ratelimit-requests-remaining",
	remainingTokens: "anthropic-ratelimit-tokens-remaining",
	limitRequests: "anthropic-ratelimit-requests-limit",
	limitTokens: "anthropic-ratelimit-tokens-limit",
	reset: "anthropic-ratelimit-requests-reset",
} as const;

const STANDARD_HEADERS = {
	remaining: "ratelimit-remaining",
	limit: "ratelimit-limit",
	reset: "ratelimit-reset",
	remainingAlt: "x-ratelimit-remaining",
	limitAlt: "x-ratelimit-limit",
	resetAlt: "x-ratelimit-reset",
} as const;

function lowercaseKeys(obj: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[key.toLowerCase()] = value;
	}
	return result;
}

function parseFirstMatch(headers: Record<string, string>, names: string[]): number | undefined {
	for (const name of names) {
		const value = headers[name];
		if (value !== undefined) {
			const num = Number.parseInt(value, 10);
			if (!Number.isNaN(num) && num >= 0) {
				return num;
			}
		}
	}
	return undefined;
}

/**
 * Parse HTTP-date format (RFC 7231).
 */
function parseHttpDate(value: string): number | null {
	const timestamp = Date.parse(value);
	if (!Number.isNaN(timestamp)) {
		const now = Date.now();
		const oneYearMs = 365 * 24 * 60 * 60 * 1000;
		if (timestamp > now - oneYearMs && timestamp < now + oneYearMs) {
			return timestamp;
		}
	}
	return null;
}

/**
 * Parse duration strings like "1s", "100ms", "1m30s", "1h30s", "2h15m30s".
 */
export function parseDuration(value: string): number | null {
	const match = value.match(/^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)(ms|s))?$/);
	if (!match) return null;
	const [, hours, minutes, secondsValue, secondsUnit] = match;
	if (!hours && !minutes && !secondsValue) return null;

	let ms = 0;
	if (hours) ms += Number.parseInt(hours, 10) * 3600_000;
	if (minutes) ms += Number.parseInt(minutes, 10) * 60_000;
	if (secondsValue) {
		const num = Number.parseFloat(secondsValue);
		ms += secondsUnit === "ms" ? num : num * 1000;
	}
	return ms;
}

function parseResetTime(value: string): number | null {
	const durationMs = parseDuration(value);
	if (durationMs !== null) return Date.now() + durationMs;

	const num = Number.parseFloat(value);
	if (!Number.isNaN(num)) {
		if (num < 1_000_000_000) return Date.now() + num * 1000;
		if (num < 10_000_000_000) return num * 1000;
		return num;
	}

	const httpDate = parseHttpDate(value);
	if (httpDate !== null) return httpDate;
	return null;
}

/**
 * Parse Retry-After header value.
 * Returns duration in milliseconds.
 */
export function parseRetryAfter(value: string): number | null {
	const seconds = Number.parseInt(value, 10);
	if (!Number.isNaN(seconds) && seconds >= 0 && String(seconds) === value.trim()) {
		return seconds * 1000;
	}
	const httpDate = parseHttpDate(value);
	if (httpDate !== null) return Math.max(0, httpDate - Date.now());
	return null;
}

/**
 * Parse rate limit headers from response.
 */
export function parseRateLimitHeaders(headers: Record<string, string>): ParsedRateLimitHeaders {
	const result: ParsedRateLimitHeaders = {};
	const h = lowercaseKeys(headers);

	result.remainingRequests = parseFirstMatch(h, [
		OPENAI_HEADERS.remainingRequests,
		ANTHROPIC_HEADERS.remainingRequests,
		STANDARD_HEADERS.remainingAlt,
		STANDARD_HEADERS.remaining,
	]);

	result.remainingTokens = parseFirstMatch(h, [
		OPENAI_HEADERS.remainingTokens,
		ANTHROPIC_HEADERS.remainingTokens,
	]);

	result.limitRequests = parseFirstMatch(h, [
		OPENAI_HEADERS.limitRequests,
		ANTHROPIC_HEADERS.limitRequests,
		STANDARD_HEADERS.limitAlt,
		STANDARD_HEADERS.limit,
	]);

	result.limitTokens = parseFirstMatch(h, [
		OPENAI_HEADERS.limitTokens,
		ANTHROPIC_HEADERS.limitTokens,
	]);

	for (const name of [
		OPENAI_HEADERS.resetRequests,
		OPENAI_HEADERS.resetTokens,
		ANTHROPIC_HEADERS.reset,
		STANDARD_HEADERS.resetAlt,
		STANDARD_HEADERS.reset,
	]) {
		if (h[name] !== undefined) {
			const parsed = parseResetTime(h[name]);
			if (parsed !== null) {
				result.resetAt = parsed;
				break;
			}
		}
	}

	if (h["retry-after-ms"] !== undefined) {
		const ms = Number.parseInt(h["retry-after-ms"], 10);
		if (!Number.isNaN(ms) && ms >= 0) {
			result.retryAfterMs = ms;
			if (result.resetAt === undefined) {
				result.resetAt = Date.now() + ms;
			}
		}
	} else if (h["retry-after"] !== undefined) {
		const parsed = parseRetryAfter(h["retry-after"]);
		if (parsed !== null) {
			result.retryAfterMs = parsed;
			if (result.resetAt === undefined) {
				result.resetAt = Date.now() + parsed;
			}
		}
	}

	return result;
}

// ============================================================================
// Fetch with Cache / Retry (from promptfoo patterns — Cloudflare-adapted)
// ============================================================================

export interface FetchCacheEntry {
	response: Response;
	expiresAt: number;
}

export interface FetchWithCacheOptions extends RequestInit {
	/** Cache TTL in milliseconds */
	cacheTtlMs?: number;
	/** Maximum retries for transient errors */
	maxRetries?: number;
	/** Base backoff in milliseconds */
	backoffMs?: number;
	/** Request timeout in milliseconds */
	timeoutMs?: number;
	/** Disable retries entirely */
	disableRetries?: boolean;
	/** Custom cache key generator */
	cacheKey?: string;
}

// Simple in-memory cache for fetch responses (per-request isolation in Workers)
const fetchCache = new Map<string, FetchCacheEntry>();

function buildCacheKey(url: RequestInfo, init?: RequestInit): string {
	const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
	const method = init?.method ?? "GET";
	const body = init?.body ? String(init.body) : "";
	return `${method}:${urlString}:${body}`;
}

function isTransientFetchError(response: Response): boolean {
	if (!response?.statusText) return false;
	const statusText = response.statusText.toLowerCase();
	switch (response.status) {
		case 502:
			return statusText.includes("bad gateway");
		case 503:
			return statusText.includes("service unavailable");
		case 504:
			return statusText.includes("gateway timeout");
		case 524:
			return statusText.includes("timeout");
		default:
			return false;
	}
}

function isRateLimitedResponse(response: Response): boolean {
	return (
		response.headers.get("X-RateLimit-Remaining") === "0" ||
		response.status === 429 ||
		response.headers.get("x-ratelimit-remaining-requests") === "0" ||
		response.headers.get("x-ratelimit-remaining-tokens") === "0"
	);
}

async function handleRateLimitWait(response: Response): Promise<void> {
	const rateLimitReset = response.headers.get("X-RateLimit-Reset");
	const retryAfter = response.headers.get("Retry-After");
	const openaiReset =
		response.headers.get("x-ratelimit-reset-requests") ||
		response.headers.get("x-ratelimit-reset-tokens");

	let waitTime = 60_000;

	if (openaiReset) {
		const parsedHeaders = parseRateLimitHeaders(Object.fromEntries(response.headers.entries()));
		if (parsedHeaders.resetAt !== undefined) {
			waitTime = Math.max(parsedHeaders.resetAt - Date.now(), 0);
		}
	} else if (rateLimitReset) {
		const resetTime = new Date(Number.parseInt(rateLimitReset) * 1000);
		waitTime = Math.max(resetTime.getTime() - Date.now() + 1000, 0);
	} else if (retryAfter) {
		waitTime = parseRetryAfter(retryAfter) ?? waitTime;
	}

	await sleep(waitTime);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with automatic caching, retries, rate-limit handling, and timeout.
 * Adapted for Cloudflare Workers (no Node-specific dependencies).
 */
export async function fetchWithCache(
	url: RequestInfo,
	options: FetchWithCacheOptions = {},
): Promise<Response> {
	const {
		cacheTtlMs,
		maxRetries = 3,
		backoffMs = 1000,
		timeoutMs = 30_000,
		disableRetries = false,
		cacheKey: customCacheKey,
		...fetchOptions
	} = options;

	const cacheKey = customCacheKey ?? buildCacheKey(url, fetchOptions);

	// Check cache for GET requests only
	const isGet = !fetchOptions.method || fetchOptions.method === "GET";
	if (isGet && cacheTtlMs !== undefined && cacheTtlMs > 0) {
		const cached = fetchCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.response.clone();
		}
		fetchCache.delete(cacheKey);
	}

	const maxAttemptRetries = disableRetries ? 0 : maxRetries;
	let lastErrorMessage: string | undefined;

	for (let i = 0; i <= maxAttemptRetries; i++) {
		let response: Response | undefined;
		try {
			// Apply timeout via AbortSignal
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

			const signal = fetchOptions.signal
				? AbortSignal.any([fetchOptions.signal, controller.signal])
				: controller.signal;

			response = await fetch(url, { ...fetchOptions, signal });
			clearTimeout(timeoutId);

			if (isRateLimitedResponse(response)) {
				lastErrorMessage = `Rate limited: ${response.status} ${response.statusText}`;
				if (i < maxAttemptRetries) {
					await handleRateLimitWait(response);
					continue;
				}
				// Return the 429 response if we're out of retries
				break;
			}

			if (!disableRetries && isTransientFetchError(response)) {
				if (i < maxAttemptRetries) {
					const backoffMsWithJitter = Math.pow(2, i) * backoffMs + Math.random() * 1000;
					await sleep(backoffMsWithJitter);
					continue;
				}
				lastErrorMessage = `Transient error: ${response.status} ${response.statusText}`;
				break;
			}

			// Cache successful GET responses
			if (isGet && cacheTtlMs !== undefined && cacheTtlMs > 0 && response.ok) {
				fetchCache.set(cacheKey, {
					response: response.clone(),
					expiresAt: Date.now() + cacheTtlMs,
				});
			}

			return response;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw error;
			}
			lastErrorMessage = error instanceof Error ? error.message : String(error);
			if (i < maxAttemptRetries) {
				const waitTime = Math.pow(2, i) * (backoffMs + Math.random() * 1000);
				await sleep(waitTime);
			}
		}
	}

	throw new Error(
		`Request failed after ${maxAttemptRetries} retries: ${lastErrorMessage ?? "unknown error"}`,
	);
}

/**
 * Clear the fetch cache. Useful in tests.
 */
export function clearFetchCache(): void {
	fetchCache.clear();
}

// ============================================================================
// Retry with Deduplication (from promptfoo patterns)
// ============================================================================

/**
 * Retries an operation with deduplication until the target count is reached or max retries are exhausted.
 */
export async function retryWithDeduplication<T>(
	operation: (currentItems: T[]) => Promise<T[]>,
	targetCount: number,
	maxConsecutiveRetries = 2,
	dedupFn: (items: T[]) => T[] = (items) =>
		Array.from(new Set(items.map((item) => safeJsonStringify(item)))).map((item) =>
			safeJsonParse(item)!,
		),
): Promise<T[]> {
	const allItems: T[] = [];
	let consecutiveRetries = 0;

	while (allItems.length < targetCount && consecutiveRetries <= maxConsecutiveRetries) {
		const newItems = await operation(allItems);

		if (!Array.isArray(newItems)) {
			consecutiveRetries++;
			continue;
		}

		const uniqueNewItems = dedupFn([...allItems, ...newItems]).slice(allItems.length);
		allItems.push(...uniqueNewItems);

		if (uniqueNewItems.length === 0) {
			consecutiveRetries++;
		} else {
			consecutiveRetries = 0;
		}
	}

	return allItems;
}

/**
 * Randomly samples n items from an array.
 */
export function sampleArray<T>(array: T[], n: number): T[] {
	const shuffled = array.slice().sort(() => 0.5 - Math.random());
	return shuffled.slice(0, Math.min(n, array.length));
}
