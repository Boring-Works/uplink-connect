import { z } from "zod";

export const SOURCE_TYPES = ["api", "webhook", "email", "file", "browser", "manual", "stream"] as const;

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

export const AlertConfigurationSchema = z.object({
	alertRules: z.array(AlertRuleSchema).default([]),
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

	// Constant-time comparison to prevent timing attacks
	if (signature.length !== expectedSignature.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < signature.length; i++) {
		result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
	}
	return result === 0;
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
