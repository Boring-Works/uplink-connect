import { type IngestEnvelope } from "@uplink/contracts";

export type NormalizedEntity = {
	entityId: string;
	sourceId: string;
	sourceType: string;
	externalId?: string;
	contentHash: string;
	observedAt: string;
	canonicalJson: string;
};

export function normalizeEnvelope(envelope: IngestEnvelope): NormalizedEntity[] {
	return envelope.records.map((record, index) => {
		const externalId = record.externalId;
		const observedAt = record.observedAt ?? envelope.collectedAt;
		const canonical = toCanonical(record.rawPayload);
		const canonicalJson = JSON.stringify(canonical);

		return {
			entityId: buildEntityId(envelope.sourceId, externalId, record.contentHash, index),
			sourceId: envelope.sourceId,
			sourceType: envelope.sourceType,
			externalId,
			contentHash: record.contentHash,
			observedAt,
			canonicalJson,
		};
	});
}

function toCanonical(payload: unknown): Record<string, unknown> {
	if (!payload || typeof payload !== "object") {
		return { value: payload };
	}

	if (Array.isArray(payload)) {
		return { items: payload };
	}

	return payload as Record<string, unknown>;
}

function buildEntityId(
	sourceId: string,
	externalId: string | undefined,
	contentHash: string,
	index: number,
): string {
	if (externalId) {
		return `${sourceId}:ext:${externalId}`;
	}

	return `${sourceId}:hash:${contentHash}:${index}`;
}
