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
		case "nws":
			return new NWSSourceAdapter();
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

interface NWSLocation {
	name: string;
	lat: number;
	lon: number;
}

interface NWSGridPoint {
	properties: {
		gridId: string;
		gridX: number;
		gridY: number;
	};
}

interface NWSStations {
	features: Array<{
		properties: {
			stationIdentifier: string;
		};
	}>;
}

interface NWSObservation {
	properties: {
		temperature: { value: number | null };
		relativeHumidity: { value: number | null };
		windSpeed: { value: number | null };
		windDirection: { value: number | null };
		textDescription: string;
		icon: string;
		timestamp: string;
	};
}

interface NWSAlert {
	id: string;
	properties: {
		event: string;
		severity: string;
		headline: string;
		description: string;
		effective: string;
		expires: string;
		geocode: { SAME: string[] };
	};
}

interface NWSAlertsResponse {
	features: NWSAlert[];
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function celsiusToFahrenheit(c: number | null): number | null {
	if (c === null) return null;
	return (c * 9) / 5 + 32;
}

function metersPerSecToMph(mps: number | null): number | null {
	if (mps === null) return null;
	return mps * 2.237;
}

function degreesToDirection(degrees: number | null): string {
	if (degrees === null) return "Unknown";
	const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
	const index = Math.round(degrees / 45) % 8;
	return directions[index];
}

export class NWSSourceAdapter implements SourceAdapter {
	type: SourceType = "nws";

	async collect(config: SourceRuntimeConfig, context: AdapterContext): Promise<AdapterResult> {
		const parsed = SourceRuntimeConfigSchema.parse(config);
		const locations = (parsed.metadata.locations as NWSLocation[] | undefined) ?? [];
		const stateCode = (parsed.metadata.stateCode as string | undefined) ?? "TN";
		const delayMs = (parsed.metadata.delayMs as number | undefined) ?? 200;
		const records: IngestRecord[] = [];

		const headers = {
			"User-Agent": "uplink-connect/1.0",
			accept: "application/geo+json",
			...parsed.requestHeaders,
		};

		// Collect weather observations for each location
		for (const location of locations) {
			try {
				// Step 1: Resolve lat/lon to grid point
				const pointsRes = await context.fetchFn(
					`https://api.weather.gov/points/${location.lat},${location.lon}`,
					{ headers },
				);
				if (!pointsRes.ok) {
					console.warn(`NWS points failed for ${location.name}: ${pointsRes.status}`);
					continue;
				}
				const pointsData = (await pointsRes.json()) as NWSGridPoint;
				const { gridId, gridX, gridY } = pointsData.properties;

				// Step 2: Get nearest observation station
				const stationsRes = await context.fetchFn(
					`https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}/stations`,
					{ headers },
				);
				if (!stationsRes.ok) {
					console.warn(`NWS stations failed for ${location.name}: ${stationsRes.status}`);
					continue;
				}
				const stationsData = (await stationsRes.json()) as NWSStations;
				const stationId = stationsData.features[0]?.properties?.stationIdentifier;
				if (!stationId) {
					console.warn(`No station found for ${location.name}`);
					continue;
				}

				// Step 3: Get latest observation
				const obsRes = await context.fetchFn(
					`https://api.weather.gov/stations/${stationId}/observations/latest`,
					{ headers },
				);
				if (!obsRes.ok) {
					console.warn(`NWS observation failed for ${location.name}: ${obsRes.status}`);
					continue;
				}
				const obsData = (await obsRes.json()) as NWSObservation;
				const props = obsData.properties;

				const record = toRecord(
					{
						location: location.name,
						stationId,
						temperature: celsiusToFahrenheit(props.temperature?.value ?? null),
						humidity: props.relativeHumidity?.value ?? null,
						windSpeed: metersPerSecToMph(props.windSpeed?.value ?? null),
						windDirection: degreesToDirection(props.windDirection?.value ?? null),
						conditions: props.textDescription || "Unknown",
						iconUrl: props.icon || null,
						observedAt: props.timestamp,
					},
					context.nowIso(),
					`${parsed.sourceId}:weather:${stationId}:${props.timestamp ?? context.nowIso()}`,
				);
				records.push(record);
			} catch (error) {
				console.warn(`NWS collect error for ${location.name}:`, error);
			}

			await sleep(delayMs);
		}

		// Step 4: Fetch state-wide alerts
		try {
			const alertsRes = await context.fetchFn(
				`https://api.weather.gov/alerts/active?area=${stateCode}`,
				{ headers },
			);
			if (alertsRes.ok) {
				const alertsData = (await alertsRes.json()) as NWSAlertsResponse;
				for (const alert of alertsData.features || []) {
					const record = toRecord(
						{
							alertId: alert.id,
							event: alert.properties.event,
							severity: alert.properties.severity,
							headline: alert.properties.headline,
							description: alert.properties.description,
							effective: alert.properties.effective,
							expires: alert.properties.expires,
							geocode: alert.properties.geocode?.SAME || [],
						},
						context.nowIso(),
						`${parsed.sourceId}:alert:${alert.id}`,
					);
					records.push(record);
				}
			}
		} catch (error) {
			console.warn("NWS alerts fetch error:", error);
		}

		return {
			records,
			hasMore: false,
			nextCursor: undefined,
		};
	}
}

function isAllowedBrowserUrl(urlStr: string): boolean {
	try {
		const url = new URL(urlStr);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return false;
		}
		if (url.username || url.password) {
			return false;
		}
		const hostname = url.hostname.toLowerCase();
		if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
			return false;
		}
		if (/^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|127\.|0\.0\.0\.0$)/.test(hostname)) {
			return false;
		}
		if (/^\[?(::1|fe80:|fc00:|fd00:)/i.test(hostname)) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

export class BrowserSourceAdapter implements SourceAdapter {
	type: SourceType = "browser";

	async collect(config: SourceRuntimeConfig, context: AdapterContext): Promise<AdapterResult> {
		const parsed = SourceRuntimeConfigSchema.parse(config);
		if (!parsed.endpointUrl) {
			throw new Error(`Source ${parsed.sourceId} is missing endpointUrl`);
		}

		if (!isAllowedBrowserUrl(parsed.endpointUrl)) {
			throw new Error(`Source ${parsed.sourceId} endpointUrl is not allowed`);
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
	const hex = (hash >>> 0).toString(16).padStart(8, "0");
	return `fnv1a:${hex}:${text.length}`;
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
