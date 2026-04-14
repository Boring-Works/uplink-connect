import type { NormalizedEntity } from "@uplink/normalizers";

// Re-export for convenience
export type VectorizeVectorMetadataFilter = import("@cloudflare/workers-types").VectorizeVectorMetadataFilter;

export interface VectorizeMetadata {
	entityId: string;
	sourceId: string;
	entityType: string;
	observedAt: string;
	contentHash: string;
}

export interface SearchResult {
	entityId: string;
	score: number;
	metadata: VectorizeMetadata;
}

/**
 * Generate embeddings for a text using Workers AI BGE model.
 * Uses @cf/baai/bge-small-en-v1.5 (384 dimensions).
 */
export async function generateEmbedding(
	env: { AI: Ai },
	text: string,
): Promise<number[]> {
	if (!env.AI) {
		throw new Error("AI binding not available");
	}
	const response = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
		text: [text],
	});

	// Handle both sync and async response types
	if (Array.isArray(response)) {
		return response[0] as number[];
	}

	if (typeof response === "object" && response !== null && "data" in response) {
		const data = (response as { data: number[][] }).data;
		if (Array.isArray(data) && data.length > 0) {
			return data[0];
		}
	}

	throw new Error("Failed to generate embedding: invalid response from AI model");
}

/**
 * Extract searchable text from canonical JSON representation.
 * Recursively extracts string values for embedding.
 */
export function extractSearchableText(canonicalJson: string): string {
	try {
		const parsed = JSON.parse(canonicalJson);
		return extractTextFromValue(parsed);
	} catch {
		return canonicalJson.slice(0, 2000); // Fallback: truncate raw JSON
	}
}

function extractTextFromValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}

	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (Array.isArray(value)) {
		return value.map(extractTextFromValue).filter(Boolean).join(" ");
	}

	if (typeof value === "object") {
		return Object.values(value as Record<string, unknown>)
			.map(extractTextFromValue)
			.filter(Boolean)
			.join(" ");
	}

	return "";
}

/**
 * Build vectorize metadata from a normalized entity.
 */
export function buildVectorMetadata(entity: NormalizedEntity): VectorizeMetadata {
	// Try to extract entity type from canonical JSON
	let entityType = "unknown";
	try {
		const parsed = JSON.parse(entity.canonicalJson);
		if (parsed.entityType && typeof parsed.entityType === "string") {
			entityType = parsed.entityType;
		} else if (parsed.type && typeof parsed.type === "string") {
			entityType = parsed.type;
		} else if (parsed.suggestedEntityType && typeof parsed.suggestedEntityType === "string") {
			entityType = parsed.suggestedEntityType;
		}
	} catch {
		// Keep default "unknown"
	}

	return {
		entityId: entity.entityId,
		sourceId: entity.sourceId,
		entityType,
		observedAt: entity.observedAt,
		contentHash: entity.contentHash,
	};
}

/**
 * Convert metadata to Vectorize-compatible format.
 */
function metadataToVectorize(metadata: VectorizeMetadata): Record<string, string> {
	return {
		entityId: metadata.entityId,
		sourceId: metadata.sourceId,
		entityType: metadata.entityType,
		observedAt: metadata.observedAt,
		contentHash: metadata.contentHash,
	};
}

/**
 * Upsert a single entity vector to Vectorize.
 */
export async function upsertEntityVector(
	env: { AI: Ai; ENTITY_INDEX: VectorizeIndex },
	entity: NormalizedEntity,
): Promise<void> {
	if (!env.ENTITY_INDEX) {
		return;
	}
	const text = extractSearchableText(entity.canonicalJson);

	if (!text.trim()) {
		// Skip entities with no searchable content
		return;
	}

	const embedding = await generateEmbedding(env, text);
	const metadata = buildVectorMetadata(entity);

	await env.ENTITY_INDEX.upsert([
		{
			id: entity.entityId,
			values: embedding,
			metadata: metadataToVectorize(metadata),
		},
	]);
}

/**
 * Upsert multiple entity vectors to Vectorize in batch.
 */
export async function upsertEntityVectors(
	env: { AI: Ai; ENTITY_INDEX: VectorizeIndex },
	entities: NormalizedEntity[],
): Promise<void> {
	if (entities.length === 0) {
		return;
	}

	// Generate embeddings for all entities
	const vectors: VectorizeVector[] = [];

	for (const entity of entities) {
		const text = extractSearchableText(entity.canonicalJson);

		if (!text.trim()) {
			// Skip entities with no searchable content
			continue;
		}

		try {
			const embedding = await generateEmbedding(env, text);
			const metadata = buildVectorMetadata(entity);

			vectors.push({
				id: entity.entityId,
				values: embedding,
				metadata: metadataToVectorize(metadata),
			});
		} catch (error) {
			// Log but don't fail the batch - other entities should still be indexed
			console.error(`Failed to generate embedding for entity ${entity.entityId}:`, error);
		}
	}

	if (vectors.length > 0) {
		const VECTORIZE_BATCH_SIZE = 100;
		const chunks = [];
		for (let i = 0; i < vectors.length; i += VECTORIZE_BATCH_SIZE) {
			chunks.push(vectors.slice(i, i + VECTORIZE_BATCH_SIZE));
		}
		for (const chunk of chunks) {
			await env.ENTITY_INDEX.upsert(chunk);
		}
	}
}

/**
 * Query similar entities using semantic search.
 */
export async function querySimilarEntities(
	env: { AI: Ai; ENTITY_INDEX: VectorizeIndex },
	query: string,
	options?: {
		topK?: number;
	filter?: VectorizeVectorMetadataFilter;
		returnValues?: boolean;
		returnMetadata?: boolean;
	},
): Promise<SearchResult[]> {
	if (!env.ENTITY_INDEX) {
		throw new Error("Vectorize index not available");
	}
	const embedding = await generateEmbedding(env, query);

	const results = await env.ENTITY_INDEX.query(embedding, {
		topK: options?.topK ?? 10,
		filter: options?.filter as VectorizeVectorMetadataFilter | undefined,
		returnValues: options?.returnValues ?? false,
		returnMetadata: options?.returnMetadata ?? true,
	});

	if (!results.matches) {
		return [];
	}

	return results.matches.map((match) => {
		const meta = match.metadata ?? {};
		return {
			entityId: match.id,
			score: match.score,
			metadata: {
				entityId: match.id,
				sourceId: (meta.sourceId as string) ?? "unknown",
				entityType: (meta.entityType as string) ?? "unknown",
				observedAt: (meta.observedAt as string) ?? new Date().toISOString(),
				contentHash: (meta.contentHash as string) ?? "",
			},
		};
	});
}

/**
 * Delete a vector from the index by entity ID.
 */
export async function deleteEntityVector(
	env: { ENTITY_INDEX: VectorizeIndex },
	entityId: string,
): Promise<void> {
	if (!env.ENTITY_INDEX) {
		return;
	}
	await env.ENTITY_INDEX.deleteByIds([entityId]);
}

/**
 * Delete multiple vectors from the index by entity IDs.
 */
export async function deleteEntityVectors(
	env: { ENTITY_INDEX: VectorizeIndex },
	entityIds: string[],
): Promise<void> {
	if (entityIds.length === 0 || !env.ENTITY_INDEX) {
		return;
	}

	await env.ENTITY_INDEX.deleteByIds(entityIds);
}
