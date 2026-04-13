import { z } from "zod";
import { type IngestRecord, type SourceType, SOURCE_TYPES } from "@uplink/contracts";

const SourceRuntimeConfigSchema = z.object({
	sourceId: z.string().min(1),
	sourceName: z.string().min(1),
	sourceType: z.enum(SOURCE_TYPES),
	endpointUrl: z.string().url().optional(),
	requestMethod: z.enum(["GET", "POST"]).default("GET"),
	requestHeaders: z.record(z.string(), z.string()).default({}),
	requestBody: z.string().optional(),
	cursor: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).default({}),
});

export type SourceRuntimeConfig = z.infer<typeof SourceRuntimeConfigSchema>;

export type AdapterContext = {
	fetchFn: typeof fetch;
	browserFetcher?: Fetcher;
	nowIso: () => string;
};

export type AdapterResult = {
	records: IngestRecord[];
	hasMore: boolean;
	nextCursor?: string;
};

export interface SourceAdapter {
	type: SourceType;
	collect(config: SourceRuntimeConfig, context: AdapterContext): Promise<AdapterResult>;
}

export function createSourceAdapter(type: SourceType): SourceAdapter {
	switch (type) {
		case "api":
			return new ApiSourceAdapter();
		case "browser":
			return new BrowserSourceAdapter();
		case "webhook":
			return new WebhookSourceAdapter();
		default:
			return new GenericSourceAdapter(type);
	}
}

export class ApiSourceAdapter implements SourceAdapter {
	type: SourceType = "api";

	async collect(config: SourceRuntimeConfig, context: AdapterContext): Promise<AdapterResult> {
		const parsed = SourceRuntimeConfigSchema.parse(config);
		if (!parsed.endpointUrl) {
			throw new Error(`Source ${parsed.sourceId} is missing endpointUrl`);
		}

		const response = await context.fetchFn(parsed.endpointUrl, {
			method: parsed.requestMethod,
			headers: {
				accept: "application/json",
				...parsed.requestHeaders,
			},
			body: parsed.requestBody,
		});

		if (!response.ok) {
			throw new Error(`Source ${parsed.sourceId} responded ${response.status}`);
		}

		const json = await response.json();
		const rows = Array.isArray(json) ? json : [json];
		const records = rows.map((row, index) => toRecord(row, context.nowIso(), `${parsed.sourceId}:${index}`));

		return {
			records,
			hasMore: false,
			nextCursor: undefined,
		};
	}
}

export class BrowserSourceAdapter implements SourceAdapter {
	type: SourceType = "browser";

	async collect(config: SourceRuntimeConfig, context: AdapterContext): Promise<AdapterResult> {
		const parsed = SourceRuntimeConfigSchema.parse(config);
		if (!parsed.endpointUrl) {
			throw new Error(`Source ${parsed.sourceId} is missing endpointUrl`);
		}

		if (!context.browserFetcher) {
			throw new Error("Browser source adapter requires browserFetcher binding");
		}

		const response = await context.browserFetcher.fetch("https://uplink-browser/internal/collect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sourceId: parsed.sourceId,
				url: parsed.endpointUrl,
				headers: parsed.requestHeaders,
				cursor: parsed.cursor,
			}),
		});

		if (!response.ok) {
			throw new Error(`Browser collector failed with ${response.status}`);
		}

		const payload = (await response.json()) as {
			records: unknown[];
			nextCursor?: string;
			hasMore?: boolean;
		};

		return {
			records: (payload.records ?? []).map((row, index) =>
				toRecord(row, context.nowIso(), `${parsed.sourceId}:browser:${index}`),
			),
			hasMore: payload.hasMore ?? false,
			nextCursor: payload.nextCursor,
		};
	}
}

export class WebhookSourceAdapter implements SourceAdapter {
	type: SourceType = "webhook";

	async collect(): Promise<AdapterResult> {
		throw new Error("Webhook sources are push-based and should not be polled");
	}
}

export class GenericSourceAdapter implements SourceAdapter {
	type: SourceType;

	constructor(type: SourceType) {
		this.type = type;
	}

	async collect(config: SourceRuntimeConfig, context: AdapterContext): Promise<AdapterResult> {
		const parsed = SourceRuntimeConfigSchema.parse(config);
		if (!parsed.endpointUrl) {
			return { records: [], hasMore: false };
		}

		const response = await context.fetchFn(parsed.endpointUrl, {
			method: parsed.requestMethod,
			headers: parsed.requestHeaders,
			body: parsed.requestBody,
		});

		const body = await response.text();
		return {
			records: [
				{
					externalId: `${parsed.sourceId}:${context.nowIso()}`,
					contentHash: fastStableHash(body),
					rawPayload: { responseStatus: response.status, body },
					observedAt: context.nowIso(),
				},
			],
			hasMore: false,
		};
	}
}

function toRecord(payload: unknown, observedAt: string, fallbackExternalId: string): IngestRecord {
	const externalId = maybeExternalId(payload) ?? fallbackExternalId;
	return {
		externalId,
		contentHash: fastStableHash(payload),
		rawPayload: payload,
		observedAt,
	};
}

function maybeExternalId(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined;
	}

	const row = payload as Record<string, unknown>;
	for (const candidate of ["id", "externalId", "uuid", "key"]) {
		const value = row[candidate];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	return undefined;
}

function fastStableHash(value: unknown): string {
	const text = typeof value === "string" ? value : stableStringify(value);
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `fnv1a:${(hash >>> 0).toString(16)}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}

	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const body = entries
		.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
		.join(",");
	return `{${body}}`;
}
