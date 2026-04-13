import type { IngestEnvelope, IngestQueueMessage } from "@uplink/contracts";
import type { NormalizedEntity } from "@uplink/normalizers";

// Pipeline is in beta - using generic interface until types are available
interface Pipeline {
	send(event: unknown): Promise<void>;
}

export type IngestEventType =
	| "ingest.received"
	| "ingest.persisted"
	| "ingest.normalized";

export type EntityEventType = "entity.created" | "entity.updated";

export type AnalyticsEventType = IngestEventType | EntityEventType;

export interface BaseAnalyticsEvent {
	eventType: AnalyticsEventType;
	timestamp: string;
	traceId?: string;
	sourceId: string;
	sourceType: string;
	runId: string;
}

export interface IngestReceivedEvent extends BaseAnalyticsEvent {
	eventType: "ingest.received";
	recordCount: number;
	collectedAt: string;
	receivedAt: string;
	triggeredBy?: string;
	replayOfRunId?: string;
}

export interface IngestPersistedEvent extends BaseAnalyticsEvent {
	eventType: "ingest.persisted";
	artifactKey: string;
	sizeBytes: number;
	recordCount: number;
}

export interface IngestNormalizedEvent extends BaseAnalyticsEvent {
	eventType: "ingest.normalized";
	normalizedCount: number;
	durationMs?: number;
}

export interface EntityCreatedEvent extends BaseAnalyticsEvent {
	eventType: "entity.created";
	entityId: string;
	externalId?: string;
	contentHash: string;
	observedAt: string;
}

export interface EntityUpdatedEvent extends BaseAnalyticsEvent {
	eventType: "entity.updated";
	entityId: string;
	externalId?: string;
	contentHash: string;
	observedAt: string;
	previousContentHash?: string;
}

export type AnalyticsEvent =
	| IngestReceivedEvent
	| IngestPersistedEvent
	| IngestNormalizedEvent
	| EntityCreatedEvent
	| EntityUpdatedEvent;

export function hasPipeline(env: unknown): env is { ANALYTICS_PIPELINE: Pipeline } {
	return (
		typeof env === "object" &&
		env !== null &&
		"ANALYTICS_PIPELINE" in env &&
		env.ANALYTICS_PIPELINE !== undefined
	);
}

function toIsoNow(): string {
	return new Date().toISOString();
}

export async function emitIngestEvent(
	env: unknown,
	eventType: IngestEventType,
	params: {
		envelope: IngestEnvelope;
		message: IngestQueueMessage;
		artifactKey?: string;
		sizeBytes?: number;
		normalizedCount?: number;
		durationMs?: number;
	},
): Promise<void> {
	if (!hasPipeline(env)) {
		return;
	}

	const { envelope, message, artifactKey, sizeBytes, normalizedCount, durationMs } =
		params;
	const baseEvent = {
		timestamp: toIsoNow(),
		traceId: envelope.traceId,
		sourceId: envelope.sourceId,
		sourceType: envelope.sourceType,
		runId: envelope.ingestId,
	};

	let event: AnalyticsEvent;

	switch (eventType) {
		case "ingest.received": {
			event = {
				...baseEvent,
				eventType: "ingest.received",
				recordCount: envelope.records.length,
				collectedAt: envelope.collectedAt,
				receivedAt: message.receivedAt,
				triggeredBy: envelope.metadata?.triggeredBy as string | undefined,
				replayOfRunId: envelope.metadata?.replayOf as string | undefined,
			};
			break;
		}
		case "ingest.persisted": {
			if (!artifactKey) {
				return;
			}
			event = {
				...baseEvent,
				eventType: "ingest.persisted",
				artifactKey,
				sizeBytes: sizeBytes ?? 0,
				recordCount: envelope.records.length,
			};
			break;
		}
		case "ingest.normalized": {
			event = {
				...baseEvent,
				eventType: "ingest.normalized",
				normalizedCount: normalizedCount ?? 0,
				durationMs,
			};
			break;
		}
		default:
			return;
	}

	try {
		await env.ANALYTICS_PIPELINE.send(event);
	} catch (error) {
		// Silently fail - analytics should not break ingestion
		// In production, you might want to log this to a separate error tracking system
	}
}

export async function emitEntityEvent(
	env: unknown,
	eventType: EntityEventType,
	params: {
		envelope: IngestEnvelope;
		entity: NormalizedEntity;
		previousContentHash?: string;
	},
): Promise<void> {
	if (!hasPipeline(env)) {
		return;
	}

	const { envelope, entity, previousContentHash } = params;
	const baseEvent = {
		timestamp: toIsoNow(),
		traceId: envelope.traceId,
		sourceId: envelope.sourceId,
		sourceType: envelope.sourceType,
		runId: envelope.ingestId,
	};

	let event: AnalyticsEvent;

	switch (eventType) {
		case "entity.created": {
			event = {
				...baseEvent,
				eventType: "entity.created",
				entityId: entity.entityId,
				externalId: entity.externalId,
				contentHash: entity.contentHash,
				observedAt: entity.observedAt,
			};
			break;
		}
		case "entity.updated": {
			event = {
				...baseEvent,
				eventType: "entity.updated",
				entityId: entity.entityId,
				externalId: entity.externalId,
				contentHash: entity.contentHash,
				observedAt: entity.observedAt,
				previousContentHash,
			};
			break;
		}
		default:
			return;
	}

	try {
		await env.ANALYTICS_PIPELINE.send(event);
	} catch (error) {
		// Silently fail - analytics should not break ingestion
	}
}

export async function emitEntityEvents(
	env: unknown,
	eventType: "entity.created" | "entity.updated",
	params: {
		envelope: IngestEnvelope;
		entities: NormalizedEntity[];
		previousContentHashes?: Map<string, string>;
	},
): Promise<void> {
	if (!hasPipeline(env)) {
		return;
	}

	const { envelope, entities, previousContentHashes } = params;

	// Emit events in parallel for efficiency
	await Promise.all(
		entities.map((entity) =>
			emitEntityEvent(env, eventType, {
				envelope,
				entity,
				previousContentHash: previousContentHashes?.get(entity.entityId),
			}),
		),
	);
}
