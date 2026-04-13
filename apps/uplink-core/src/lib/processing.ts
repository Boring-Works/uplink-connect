import type { NormalizedEntity } from "@uplink/normalizers";
import {
	IngestEnvelopeSchema,
	IngestQueueMessageSchema,
	buildRawArtifactKey,
	createIngestQueueMessage,
	toIsoNow,
	type IngestQueueMessage,
	type RetryAttempt,
} from "@uplink/contracts";
import { normalizeEnvelope } from "@uplink/normalizers";
import type { Env } from "../types";
import {
	insertRunIfMissing,
	recordIngestError,
	setRunStatus,
	updateErrorRetryState,
	upsertNormalizedEntities,
} from "./db";
import { writeIngestMetrics, writeEntityMetrics } from "./metrics";
import { upsertEntityVectors } from "./vectorize";
import {
	withRetry,
	classifyError,
	isDuplicateError,
	D1_RETRY_POLICY,
	R2_RETRY_POLICY,
	VECTORIZE_RETRY_POLICY,
	CircuitBreakerOpenError,
} from "./retry";
import { Logger } from "./logging";

// Circuit breakers for external services (module-level singleton)
const circuitBreakers = new Map<string, import("./retry").CircuitBreaker>();

// Logger for structured logging
const logger = new Logger("processing");

async function getCircuitBreaker(name: string): Promise<import("./retry").CircuitBreaker> {
	const { CircuitBreaker } = await import("./retry");
	if (!circuitBreakers.has(name)) {
		circuitBreakers.set(name, new CircuitBreaker(name));
	}
	return circuitBreakers.get(name)!;
}

export async function processQueueBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		let errorId: string | undefined;

		try {
			const parsed = IngestQueueMessageSchema.safeParse(message.body);
			if (!parsed.success) {
				// Validation errors are permanent - don't retry
				errorId = await recordIngestError(env.CONTROL_DB, {
					phase: "validation",
					errorCode: "INVALID_MESSAGE",
					errorMessage: parsed.error.message,
					payload: safeStringify(message.body),
					status: "dead_letter",
				});
				message.ack();
				continue;
			}

			await handleIngestMessage(env, parsed.data);
			message.ack();
		} catch (error) {
			const fallback = error instanceof Error ? error.message : "Unknown queue processing failure";
			const classification = classifyError(error);

			// Record error with retry tracking
			if (!errorId) {
				errorId = await recordIngestError(env.CONTROL_DB, {
					phase: "processing",
					errorCode: classification.errorCategory.toUpperCase(),
					errorMessage: fallback,
					payload: safeStringify(message.body),
					status: classification.shouldSendToDlq ? "dead_letter" : "pending",
					errorCategory: classification.errorCategory,
				});
			}

			// Decide whether to retry or send to DLQ
			if (classification.shouldSendToDlq) {
				console.warn(`[processQueueBatch] Permanent error, sending to DLQ`, {
					errorId,
					category: classification.errorCategory,
				});
				await sendToDlq(env, message.body, classification, fallback);
				message.ack();
			} else if (message.attempts < 3) {
				// Let the queue retry
				console.warn(`[processQueueBatch] Transient error, will retry`, {
					errorId,
					attempt: message.attempts,
					category: classification.errorCategory,
				});
				message.retry();
			} else {
				// Max retries exceeded, send to DLQ
				console.error(`[processQueueBatch] Max retries exceeded, sending to DLQ`, {
					errorId,
					attempts: message.attempts,
				});
				await sendToDlq(env, message.body, classification, fallback);
				message.ack();
			}
		}
	}
}

export async function handleIngestMessage(env: Env, message: IngestQueueMessage): Promise<void> {
	const { envelope, receivedAt, requestId } = message;
	if (!envelope || typeof envelope !== "object") {
		throw new Error("Invalid ingest message: envelope is required");
	}
	if (!Array.isArray(envelope.records)) {
		throw new Error("Invalid ingest message: envelope.records must be an array");
	}

	const runId = envelope.ingestId;
	const rawJson = JSON.stringify(envelope);
	const processStartTime = Date.now();

	// Insert run record with retry logic for idempotency
	await withRetry(
		() =>
			insertRunIfMissing(env.CONTROL_DB, {
				runId,
				sourceId: envelope.sourceId,
				sourceName: envelope.sourceName,
				sourceType: envelope.sourceType,
				status: "received",
				collectedAt: envelope.collectedAt,
				receivedAt,
				recordCount: envelope.records.length,
				envelope,
				triggeredBy: "queue",
				replayOfRunId: getReplaySource(envelope),
			}),
		D1_RETRY_POLICY,
		{
			operationName: "insertRunIfMissing",
			runId,
			sourceId: envelope.sourceId,
			requestId,
		},
	);

	try {
		const rawKey = buildRawArtifactKey(envelope);

		// Persist to R2 with retry logic and circuit breaker
		const r2Breaker = await getCircuitBreaker("R2");
		await r2Breaker.execute(() =>
			withRetry(
				() =>
					env.RAW_BUCKET.put(rawKey, rawJson, {
						httpMetadata: { contentType: "application/json" },
					}),
				R2_RETRY_POLICY,
				{
					operationName: "R2.put",
					runId,
					sourceId: envelope.sourceId,
					requestId,
				},
			),
		);

		// Insert raw artifact with retry logic
		await withRetry(
			() =>
				env.CONTROL_DB.prepare(
					`INSERT INTO raw_artifacts (
						artifact_id, run_id, source_id, artifact_type,
						r2_key, size_bytes, created_at
					) VALUES (?, ?, ?, ?, ?, ?, unixepoch())
					ON CONFLICT(artifact_id) DO NOTHING`,
				)
					.bind(`${runId}:raw`, runId, envelope.sourceId, "raw-envelope", rawKey, rawJson.length)
					.run(),
			D1_RETRY_POLICY,
			{
				operationName: "insertRawArtifact",
				runId,
				sourceId: envelope.sourceId,
				requestId,
			},
		);

		await setRunStatus(env.CONTROL_DB, runId, "persisted", { artifactKey: rawKey });

		const entities = normalizeEnvelope(envelope);

		// Upsert normalized entities with retry logic
		await withRetry(
			() => upsertNormalizedEntities(env.CONTROL_DB, runId, entities),
			D1_RETRY_POLICY,
			{
				operationName: "upsertNormalizedEntities",
				runId,
				sourceId: envelope.sourceId,
				requestId,
			},
		);

		// Track entity metrics
		for (const entity of entities) {
			writeEntityMetrics(env, {
				sourceId: envelope.sourceId,
				sourceType: envelope.sourceType,
				entityCount: 1,
				isNew: false,
				isUpdate: false,
			});
		}

		// Index entities in Vectorize with retry logic (non-blocking)
		const aiBinding = (env as Partial<Env>).AI;
		const entityIndexBinding = (env as Partial<Env>).ENTITY_INDEX;
		if (aiBinding && entityIndexBinding) {
			try {
				const vectorizeBreaker = await getCircuitBreaker("Vectorize");
				await vectorizeBreaker.execute(() =>
					withRetry(
						() => upsertEntityVectors({ AI: aiBinding, ENTITY_INDEX: entityIndexBinding }, entities),
						VECTORIZE_RETRY_POLICY,
						{
							operationName: "upsertEntityVectors",
							runId,
							sourceId: envelope.sourceId,
							requestId,
						},
					),
				);
			} catch (vectorError) {
				// Vectorize failures are non-critical - log but don't fail the ingest
				if (vectorError instanceof CircuitBreakerOpenError) {
					logger.warn("Vectorize circuit breaker open, skipping indexing", {
						runId,
						sourceId: envelope.sourceId,
						remainingMs: vectorError.remainingMs,
					});
				} else {
					logger.warn("Vectorize indexing failed (non-critical)", {
						runId,
						sourceId: envelope.sourceId,
						error: vectorError instanceof Error ? vectorError.message : String(vectorError),
					});
				}
			}
		}

		const endedAt = toIsoNow();
		await setRunStatus(env.CONTROL_DB, runId, "normalized", {
			normalizedCount: entities.length,
			endedAt,
		});

		// Write comprehensive metrics
		const processingTimeMs = Date.now() - processStartTime;
		writeIngestMetrics(env, {
			sourceId: envelope.sourceId,
			sourceType: envelope.sourceType,
			runId,
			status: "success",
			recordCount: envelope.records.length,
			normalizedCount: entities.length,
			errorCount: 0,
			processingTimeMs,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown processing error";
		const classification = classifyError(error);
		const endedAt = toIsoNow();

		// Check if this is a duplicate error - if so, treat as success
		if (isDuplicateError(error)) {
			logger.info("Duplicate detected, treating as success", { runId, sourceId: envelope.sourceId });
			await setRunStatus(env.CONTROL_DB, runId, "normalized", {
				normalizedCount: envelope.records.length,
				endedAt,
			});
			return;
		}

		await setRunStatus(env.CONTROL_DB, runId, "failed", {
			errorCount: 1,
			endedAt,
		});

		// Record error with full context
		const errorId = await recordIngestError(env.CONTROL_DB, {
			runId,
			sourceId: envelope.sourceId,
			phase: "processing",
			errorCode: `INGEST_${classification.errorCategory.toUpperCase()}`,
			errorMessage,
			payload: rawJson,
			status: classification.shouldSendToDlq ? "dead_letter" : "pending",
			errorCategory: classification.errorCategory,
		});

		// Write failure metrics
		const processingTimeMs = Date.now() - processStartTime;
		writeIngestMetrics(env, {
			sourceId: envelope.sourceId,
			sourceType: envelope.sourceType,
			runId,
			status: "failure",
			recordCount: envelope.records.length,
			normalizedCount: 0,
			errorCount: 1,
			processingTimeMs,
		});

		logger.error("Processing failed", {
			runId,
			sourceId: envelope.sourceId,
			requestId,
			category: classification.errorCategory,
			isTransient: classification.isTransient,
			errorId,
		});

		throw error;
	}
}

async function sendToDlq(
	env: Env,
	originalPayload: unknown,
	classification: import("./retry").ErrorClassification,
	errorMessage: string,
): Promise<void> {
	const dlqMessage = {
		originalPayload,
		classification,
		errorMessage,
		failedAt: toIsoNow(),
		_dlqMetadata: {
			sentAt: toIsoNow(),
			retryCount: 0,
			maxRetries: 3,
		},
	};

	await env.DLQ.send(dlqMessage);
}

function getReplaySource(envelope: IngestQueueMessage["envelope"]): string | undefined {
	const replayOf = envelope.metadata?.replayOf;
	return typeof replayOf === "string" ? replayOf : undefined;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "<unserializable>";
	}
}

function buildRetryMessage(payload: string, requestId: string): IngestQueueMessage | null {
	let parsedPayload: unknown;
	try {
		parsedPayload = JSON.parse(payload);
	} catch {
		return null;
	}

	const queueMessage = IngestQueueMessageSchema.safeParse(parsedPayload);
	if (queueMessage.success) {
		return queueMessage.data;
	}

	const envelope = IngestEnvelopeSchema.safeParse(parsedPayload);
	if (envelope.success) {
		return createIngestQueueMessage(envelope.data, { requestId });
	}

	return null;
}

async function getPreviousContentHashes(
	db: D1Database,
	entities: NormalizedEntity[],
): Promise<Map<string, string>> {
	if (entities.length === 0) {
		return new Map();
	}

	const hashes = new Map<string, string>();

	// Query in batches to avoid too many parameters
	const batchSize = 50;
	for (let i = 0; i < entities.length; i += batchSize) {
		const batch = entities.slice(i, i + batchSize);
		const placeholders = batch.map(() => "?").join(",");
		const entityIds = batch.map((e) => e.entityId);

		const result = await db
			.prepare(
				`SELECT entity_id, content_hash FROM entities_current WHERE entity_id IN (${placeholders})`,
			)
			.bind(...entityIds)
			.all<{ entity_id: string; content_hash: string }>();

		for (const row of result.results ?? []) {
			hashes.set(row.entity_id, row.content_hash);
		}
	}

	return hashes;
}

// ============================================================================
// Manual Error Retry Handler
// ============================================================================

export async function retryFailedOperation(
	env: Env,
	errorId: string,
	options: {
		force?: boolean;
		triggeredBy?: string;
	},
): Promise<{
	success: boolean;
	newStatus: string;
	message: string;
	retryAttemptId?: string;
}> {
	const { force = false, triggeredBy = "manual" } = options;

	// Get the error record
	const { getIngestError, checkIdempotencyKey, recordIdempotencyKey } = await import("./db");
	const error = await getIngestError(env.CONTROL_DB, errorId);

	if (!error) {
		return {
			success: false,
			newStatus: "unknown",
			message: `Error ${errorId} not found`,
		};
	}

	const status = error.status as string;
	const retryCount = (error.retry_count as number) ?? 0;
	const maxRetries = (error.max_retries as number) ?? 3;

	// Check if already resolved
	if (status === "resolved") {
		return {
			success: true,
			newStatus: "resolved",
			message: "Error already resolved",
		};
	}

	// Check retry limit unless forced
	if (!force && retryCount >= maxRetries) {
		return {
			success: false,
			newStatus: status,
			message: `Max retries (${maxRetries}) exceeded. Use force=true to override.`,
		};
	}

	// Check idempotency
	const idempotencyKey = `retry:${errorId}:${Date.now().toString().slice(0, -3)}`; // Per-minute granularity
	const idempotencyCheck = await checkIdempotencyKey(env.CONTROL_DB, idempotencyKey);

	if (idempotencyCheck.exists && idempotencyCheck.result === "success") {
		return {
			success: true,
			newStatus: status,
			message: "Retry already completed successfully for this time window",
		};
	}

	// Parse payload and retry
	const payload = error.payload as string | null;
	const runId = error.run_id as string | null;
	const sourceId = error.source_id as string | null;
	const phase = error.phase as string;

	const retryAttemptId = crypto.randomUUID();
	const retryAttempt: RetryAttempt = {
		attemptNumber: retryCount + 1,
		timestamp: toIsoNow(),
		errorCode: "RETRY_ATTEMPT",
		errorMessage: `Manual retry initiated by ${triggeredBy}`,
		delayMs: 0,
	};

	try {
		let retrySuccess = false;

		if (phase === "validation" || !payload) {
			// Validation errors can't be retried
			return {
				success: false,
				newStatus: status,
				message: "Validation errors cannot be retried",
			};
		}

		// Parse original payload and retry
		const message = buildRetryMessage(payload, `retry:${errorId}`);
		if (message) {
			await handleIngestMessage(env, message);
			retrySuccess = true;
		} else if (runId) {
			// Fallback to stored run envelope when error payload is not replayable
			const run = await env.CONTROL_DB.prepare(
				"SELECT envelope_json FROM ingest_runs WHERE run_id = ?",
			)
				.bind(runId)
				.first<{ envelope_json: string }>();

			if (run?.envelope_json) {
				const fallbackMessage = buildRetryMessage(run.envelope_json, `retry:${runId}`);
				if (fallbackMessage) {
					await handleIngestMessage(env, fallbackMessage);
					retrySuccess = true;
				}
			}
		}

		if (retrySuccess) {
			// Update error status to resolved
			await updateErrorRetryState(env.CONTROL_DB, errorId, {
				status: "resolved",
				retryCount: retryCount + 1,
				lastRetryAt: Math.floor(Date.now() / 1000),
				retryAttempts: [...(JSON.parse((error.retry_attempts_json as string) || "[]") as RetryAttempt[]), retryAttempt],
				resolvedAt: Math.floor(Date.now() / 1000),
				resolvedBy: triggeredBy,
				resolutionNotes: `Successfully retried via manual retry API`,
			});

			await recordIdempotencyKey(env.CONTROL_DB, idempotencyKey, errorId, "success");

			return {
				success: true,
				newStatus: "resolved",
				message: "Retry successful",
				retryAttemptId,
			};
		}

		throw new Error("Failed to parse or process original payload");
	} catch (retryError) {
		const errorMsg = retryError instanceof Error ? retryError.message : String(retryError);

		// Update error with retry attempt
		await updateErrorRetryState(env.CONTROL_DB, errorId, {
			status: retryCount + 1 >= maxRetries ? "dead_letter" : "retrying",
			retryCount: retryCount + 1,
			lastRetryAt: Math.floor(Date.now() / 1000),
			retryAttempts: [...(JSON.parse((error.retry_attempts_json as string) || "[]") as RetryAttempt[]), {
				...retryAttempt,
				errorCode: "RETRY_FAILED",
				errorMessage: errorMsg,
			}],
		});

		await recordIdempotencyKey(env.CONTROL_DB, idempotencyKey, errorId, "failed");

		return {
			success: false,
			newStatus: retryCount + 1 >= maxRetries ? "dead_letter" : "retrying",
			message: `Retry failed: ${errorMsg}`,
			retryAttemptId,
		};
	}
}
