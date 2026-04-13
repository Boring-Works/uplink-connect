import { describe, it, expect } from "vitest";
import {
	IngestEnvelopeSchema,
	IngestQueueMessageSchema,
	SourceConfigSchema,
	SourcePolicySchema,
	SourceTriggerRequestSchema,
	EntitySearchRequestSchema,
	ErrorFilterSchema,
	ErrorRetryRequestSchema,
	CollectionWorkflowParamsSchema,
	AlertConfigurationSchema,
	AlertRuleSchema,
	RetryPolicySchema,
	CircuitBreakerPolicySchema,
	ErrorClassificationSchema,
	AnalyticsEventSchema,
	toIsoNow,
	createIngestQueueMessage,
	SOURCE_TYPES,
} from "../index";

describe("contracts", () => {
	describe("IngestEnvelopeSchema", () => {
		it("accepts valid envelope with all required fields", () => {
			const result = IngestEnvelopeSchema.safeParse({
				schemaVersion: "1.0",
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: { id: 1 } }],
			});
			expect(result.success).toBe(true);
		});

		it("rejects missing schemaVersion", () => {
			const result = IngestEnvelopeSchema.safeParse({
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
			});
			expect(result.success).toBe(false);
		});

		it("rejects invalid schemaVersion", () => {
			const result = IngestEnvelopeSchema.safeParse({
				schemaVersion: "2.0",
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
			});
			expect(result.success).toBe(false);
		});

		it("rejects empty records array", () => {
			const result = IngestEnvelopeSchema.safeParse({
				schemaVersion: "1.0",
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [],
			});
			expect(result.success).toBe(false);
		});

		it("rejects contentHash shorter than 16 chars", () => {
			const result = IngestEnvelopeSchema.safeParse({
				schemaVersion: "1.0",
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "short", rawPayload: {} }],
			});
			expect(result.success).toBe(false);
		});

		it("accepts all valid source types", () => {
			for (const sourceType of SOURCE_TYPES) {
				const result = IngestEnvelopeSchema.safeParse({
					schemaVersion: "1.0",
					ingestId: "run-12345678",
					sourceId: "src-1",
					sourceName: "Test",
					sourceType,
					collectedAt: "2024-01-01T00:00:00.000Z",
					records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
				});
				expect(result.success).toBe(true);
			}
		});

		it("rejects invalid source type", () => {
			const result = IngestEnvelopeSchema.safeParse({
				schemaVersion: "1.0",
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "invalid",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
			});
			expect(result.success).toBe(false);
		});

		it("accepts optional metadata", () => {
			const result = IngestEnvelopeSchema.safeParse({
				schemaVersion: "1.0",
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
				metadata: { key: "value", nested: { a: 1 } },
			});
			expect(result.success).toBe(true);
		});

		it("accepts optional traceId", () => {
			const result = IngestEnvelopeSchema.safeParse({
				schemaVersion: "1.0",
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
				traceId: "trace-123",
			});
			expect(result.success).toBe(true);
		});

		it("accepts optional nextCursor", () => {
			const result = IngestEnvelopeSchema.safeParse({
				schemaVersion: "1.0",
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
				hasMore: true,
				nextCursor: "cursor-123",
			});
			expect(result.success).toBe(true);
		});
	});

	describe("SourceConfigSchema", () => {
		it("accepts minimal valid config", () => {
			const result = SourceConfigSchema.safeParse({
				sourceId: "src-1",
				name: "Test Source",
				type: "api",
				adapterType: "api",
				policy: {
					leaseTtlSeconds: 60,
					minIntervalSeconds: 60,
					maxRecordsPerRun: 100,
					retryLimit: 3,
					timeoutSeconds: 60,
				},
			});
			expect(result.success).toBe(true);
		});

		it("defaults status to active", () => {
			const result = SourceConfigSchema.safeParse({
				sourceId: "src-1",
				name: "Test Source",
				type: "api",
				adapterType: "api",
				policy: {
					leaseTtlSeconds: 60,
					minIntervalSeconds: 60,
					maxRecordsPerRun: 100,
					retryLimit: 3,
					timeoutSeconds: 60,
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.status).toBe("active");
			}
		});

		it("defaults requestMethod to GET", () => {
			const result = SourceConfigSchema.safeParse({
				sourceId: "src-1",
				name: "Test Source",
				type: "api",
				adapterType: "api",
				policy: {
					leaseTtlSeconds: 60,
					minIntervalSeconds: 60,
					maxRecordsPerRun: 100,
					retryLimit: 3,
					timeoutSeconds: 60,
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.requestMethod).toBe("GET");
			}
		});

		it("rejects missing policy", () => {
			const result = SourceConfigSchema.safeParse({
				sourceId: "src-1",
				name: "Test Source",
				type: "api",
				adapterType: "api",
			});
			expect(result.success).toBe(false);
		});

		it("rejects leaseTtlSeconds below 30", () => {
			const result = SourceConfigSchema.safeParse({
				sourceId: "src-1",
				name: "Test Source",
				type: "api",
				adapterType: "api",
				policy: {
					leaseTtlSeconds: 10,
					minIntervalSeconds: 60,
					maxRecordsPerRun: 100,
					retryLimit: 3,
					timeoutSeconds: 60,
				},
			});
			expect(result.success).toBe(false);
		});

		it("rejects retryLimit above 10", () => {
			const result = SourceConfigSchema.safeParse({
				sourceId: "src-1",
				name: "Test Source",
				type: "api",
				adapterType: "api",
				policy: {
					leaseTtlSeconds: 60,
					minIntervalSeconds: 60,
					maxRecordsPerRun: 100,
					retryLimit: 15,
					timeoutSeconds: 60,
				},
			});
			expect(result.success).toBe(false);
		});
	});

	describe("SourcePolicySchema", () => {
		it("accepts valid policy", () => {
			const result = SourcePolicySchema.safeParse({
				leaseTtlSeconds: 300,
				minIntervalSeconds: 60,
				maxRecordsPerRun: 1000,
				retryLimit: 3,
				timeoutSeconds: 60,
			});
			expect(result.success).toBe(true);
		});

		it("applies all defaults", () => {
			const result = SourcePolicySchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.leaseTtlSeconds).toBe(300);
				expect(result.data.minIntervalSeconds).toBe(60);
				expect(result.data.maxRecordsPerRun).toBe(1000);
				expect(result.data.retryLimit).toBe(3);
				expect(result.data.timeoutSeconds).toBe(60);
			}
		});

		it("rejects timeoutSeconds above 600", () => {
			const result = SourcePolicySchema.safeParse({
				timeoutSeconds: 601,
			});
			expect(result.success).toBe(false);
		});
	});

	describe("SourceTriggerRequestSchema", () => {
		it("accepts empty object with defaults", () => {
			const result = SourceTriggerRequestSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.triggeredBy).toBe("system");
				expect(result.data.force).toBe(false);
			}
		});

		it("accepts explicit values", () => {
			const result = SourceTriggerRequestSchema.safeParse({
				triggeredBy: "manual",
				force: true,
				reason: "test",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.triggeredBy).toBe("manual");
				expect(result.data.force).toBe(true);
				expect(result.data.reason).toBe("test");
			}
		});
	});

	describe("EntitySearchRequestSchema", () => {
		it("accepts valid search request", () => {
			const result = EntitySearchRequestSchema.safeParse({
				query: "test query",
				topK: 10,
			});
			expect(result.success).toBe(true);
		});

		it("rejects empty query", () => {
			const result = EntitySearchRequestSchema.safeParse({
				query: "",
				topK: 10,
			});
			expect(result.success).toBe(false);
		});

		it("rejects topK above 100", () => {
			const result = EntitySearchRequestSchema.safeParse({
				query: "test",
				topK: 101,
			});
			expect(result.success).toBe(false);
		});
	});

	describe("ErrorFilterSchema", () => {
		it("accepts valid filter", () => {
			const result = ErrorFilterSchema.safeParse({
				status: "pending",
				limit: 50,
				offset: 0,
			});
			expect(result.success).toBe(true);
		});

		it("accepts partial filter", () => {
			const result = ErrorFilterSchema.safeParse({
				limit: 10,
			});
			expect(result.success).toBe(true);
		});
	});

	describe("ErrorRetryRequestSchema", () => {
		it("accepts valid retry request", () => {
			const result = ErrorRetryRequestSchema.safeParse({
				force: true,
				triggeredBy: "manual",
			});
			expect(result.success).toBe(true);
		});

		it("applies defaults", () => {
			const result = ErrorRetryRequestSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.force).toBe(false);
				expect(result.data.triggeredBy).toBe("manual");
			}
		});
	});

	describe("CollectionWorkflowParamsSchema", () => {
		it("accepts valid params", () => {
			const result = CollectionWorkflowParamsSchema.safeParse({
				sourceId: "src-1",
				leaseToken: "token-123",
				triggeredBy: "system",
			});
			expect(result.success).toBe(true);
		});

		it("rejects missing leaseToken", () => {
			const result = CollectionWorkflowParamsSchema.safeParse({
				sourceId: "src-1",
				triggeredBy: "system",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("AlertConfigurationSchema", () => {
		it("accepts empty config", () => {
			const result = AlertConfigurationSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.alertRules).toEqual([]);
			}
		});

		it("accepts config with rules", () => {
			const result = AlertConfigurationSchema.safeParse({
				alertRules: [
					{
						alertType: "source_failure_rate",
						severity: "critical",
						threshold: 0.5,
						windowSeconds: 3600,
						enabled: true,
					},
				],
			});
			expect(result.success).toBe(true);
		});
	});

	describe("AlertRuleSchema", () => {
		it("rejects negative threshold", () => {
			const result = AlertRuleSchema.safeParse({
				alertType: "source_failure_rate",
				severity: "critical",
				threshold: -0.5,
				windowSeconds: 60,
				enabled: true,
			});
			expect(result.success).toBe(false);
		});

		it("rejects negative windowSeconds", () => {
			const result = AlertRuleSchema.safeParse({
				alertType: "source_failure_rate",
				severity: "critical",
				threshold: 0.5,
				windowSeconds: -1,
				enabled: true,
			});
			expect(result.success).toBe(false);
		});
	});

	describe("IngestQueueMessageSchema", () => {
		it("accepts valid queue message", () => {
			const result = IngestQueueMessageSchema.safeParse({
				envelope: {
					schemaVersion: "1.0",
					ingestId: "run-12345678",
					sourceId: "src-1",
					sourceName: "Test",
					sourceType: "api",
					collectedAt: "2024-01-01T00:00:00.000Z",
					records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
				},
				receivedAt: "2024-01-01T00:00:00.000Z",
			});
			expect(result.success).toBe(true);
		});
	});

	describe("RetryPolicySchema", () => {
		it("applies defaults", () => {
			const result = RetryPolicySchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.maxAttempts).toBe(3);
				expect(result.data.baseDelayMs).toBe(1000);
			}
		});

		it("rejects maxAttempts above 10", () => {
			const result = RetryPolicySchema.safeParse({ maxAttempts: 11 });
			expect(result.success).toBe(false);
		});
	});

	describe("CircuitBreakerPolicySchema", () => {
		it("applies defaults", () => {
			const result = CircuitBreakerPolicySchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.failureThreshold).toBe(5);
				expect(result.data.resetTimeoutMs).toBe(30000);
			}
		});
	});

	describe("ErrorClassificationSchema", () => {
		it("accepts valid classification", () => {
			const result = ErrorClassificationSchema.safeParse({
				isTransient: true,
				isRetryable: true,
				errorCategory: "timeout",
				shouldSendToDlq: false,
				suggestedRetryDelayMs: 5000,
			});
			expect(result.success).toBe(true);
		});

		it("rejects invalid errorCategory", () => {
			const result = ErrorClassificationSchema.safeParse({
				isTransient: true,
				isRetryable: true,
				errorCategory: "bad_category",
				shouldSendToDlq: false,
			});
			expect(result.success).toBe(false);
		});
	});

	describe("AnalyticsEventSchema", () => {
		it("accepts ingest.received event", () => {
			const result = AnalyticsEventSchema.safeParse({
				eventType: "ingest.received",
				timestamp: "2024-01-01T00:00:00.000Z",
				sourceId: "src-1",
				sourceType: "api",
				runId: "run-1",
				recordCount: 5,
				collectedAt: "2024-01-01T00:00:00.000Z",
				receivedAt: "2024-01-01T00:00:00.000Z",
			});
			expect(result.success).toBe(true);
		});

		it("accepts entity.created event", () => {
			const result = AnalyticsEventSchema.safeParse({
				eventType: "entity.created",
				timestamp: "2024-01-01T00:00:00.000Z",
				sourceId: "src-1",
				sourceType: "api",
				runId: "run-1",
				entityId: "ent-1",
				contentHash: "a".repeat(20),
				observedAt: "2024-01-01T00:00:00.000Z",
			});
			expect(result.success).toBe(true);
		});

		it("rejects invalid eventType", () => {
			const result = AnalyticsEventSchema.safeParse({
				eventType: "invalid",
				timestamp: "2024-01-01T00:00:00.000Z",
				sourceId: "src-1",
				sourceType: "api",
				runId: "run-1",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("createIngestQueueMessage", () => {
		it("creates message with envelope and receivedAt", () => {
			const envelope = {
				schemaVersion: "1.0" as const,
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api" as const,
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
				hasMore: false,
			};
			const message = createIngestQueueMessage(envelope);
			expect(message.envelope).toEqual(envelope);
			expect(message.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it("includes requestId when provided", () => {
			const envelope = {
				schemaVersion: "1.0" as const,
				ingestId: "run-12345678",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api" as const,
				collectedAt: "2024-01-01T00:00:00.000Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: {} }],
				hasMore: false,
			};
			const message = createIngestQueueMessage(envelope, { requestId: "req-123" });
			expect(message.requestId).toBe("req-123");
		});
	});

	describe("toIsoNow", () => {
		it("returns ISO 8601 formatted string", () => {
			const now = toIsoNow();
			expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		});
	});

	describe("constants", () => {
		it("validates source types", () => {
			expect(SOURCE_TYPES).toContain("api");
			expect(SOURCE_TYPES).toContain("webhook");
			expect(SOURCE_TYPES).toContain("browser");
			expect(SOURCE_TYPES).toContain("manual");
			expect(SOURCE_TYPES).toContain("email");
			expect(SOURCE_TYPES).toContain("file");
			expect(SOURCE_TYPES).toContain("stream");
		});

		it("has exactly 7 source types", () => {
			expect(SOURCE_TYPES).toHaveLength(7);
		});

		it("does not contain duplicate source types", () => {
			const unique = new Set(SOURCE_TYPES);
			expect(unique.size).toBe(SOURCE_TYPES.length);
		});
	});
});
