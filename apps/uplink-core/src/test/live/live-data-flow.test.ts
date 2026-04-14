/**
 * Live Data Flow Validation Tests
 *
 * These tests verify that when data enters Uplink Connect, it actually
 * flows through the entire pipeline and becomes queryable.
 *
 * Run without credentials: basic health/reachability
 * Run with credentials: full end-to-end data validation
 *
 * Required env vars for full tests:
 * - UPLINK_LIVE_INGEST_API_KEY
 * - UPLINK_LIVE_INTERNAL_KEY
 */

import { describe, it, expect, beforeAll } from "vitest";

const ENDPOINTS = {
	edge: "https://uplink-edge.codyboring.workers.dev",
	core: "https://uplink-core.codyboring.workers.dev",
};

const INGEST_KEY = process.env.UPLINK_LIVE_INGEST_API_KEY;
const INTERNAL_KEY = process.env.UPLINK_LIVE_INTERNAL_KEY;
const hasCredentials = !!(INGEST_KEY && INTERNAL_KEY);

const testOrSkip = hasCredentials ? it : it.skip;

// Unique IDs for this test run
const RUN_ID = `live-data-${Date.now()}`;
const SOURCE_ID = `live-test-source-${Date.now()}`;

async function waitForQueueProcessing(ms = 6000): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Live Data Flow - Reachability", () => {
	it("edge is reachable", async () => {
		const res = await fetch(`${ENDPOINTS.edge}/health`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
	});

	it("core is reachable", async () => {
		const res = await fetch(`${ENDPOINTS.core}/health`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
	});

	it("all deep health checks pass", async () => {
		const res = await fetch(`${ENDPOINTS.core}/health`);
		const data = await res.json();
		expect(data.status).toBe("healthy");
		expect(data.components).toBeInstanceOf(Array);
		for (const component of data.components) {
			expect(component.status).toMatch(/healthy|degraded/);
		}
	});
});

describe("Live Data Flow - Ingest to Query", () => {
	beforeAll(() => {
		if (!hasCredentials) {
			console.log("Skipping live data flow tests — set UPLINK_LIVE_INGEST_API_KEY and UPLINK_LIVE_INTERNAL_KEY");
		}
	});

	testOrSkip("creates a live test source", async () => {
		const sourceConfig = {
			sourceId: SOURCE_ID,
			name: "Live Data Flow Source",
			type: "api",
			status: "active",
			adapterType: "generic-api",
			endpointUrl: "https://httpbin.org/get",
			requestMethod: "GET",
			requestHeaders: {},
			metadata: { liveTestRun: true },
			policy: {
				minIntervalSeconds: 10,
				leaseTtlSeconds: 60,
				maxRecordsPerRun: 100,
				retryLimit: 2,
				timeoutSeconds: 30,
			},
		};

		const res = await fetch(`${ENDPOINTS.core}/internal/sources`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-uplink-internal-key": INTERNAL_KEY!,
			},
			body: JSON.stringify(sourceConfig),
		});

		expect(res.status).toBe(200);
	});

	testOrSkip("ingests data through edge and gets 202", async () => {
		const envelope = {
			schemaVersion: "1.0",
			ingestId: RUN_ID,
			sourceId: SOURCE_ID,
			sourceName: "Live Data Flow Source",
			sourceType: "api",
			collectedAt: new Date().toISOString(),
			records: [
				{
					externalId: `ext-${RUN_ID}`,
					contentHash: `hash-${RUN_ID}-001`,
					rawPayload: {
						testMarker: RUN_ID,
						value: 42,
						nested: { verified: true },
					},
					observedAt: new Date().toISOString(),
				},
			],
		};

		const res = await fetch(`${ENDPOINTS.edge}/v1/intake`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"authorization": `Bearer ${INGEST_KEY}`,
			},
			body: JSON.stringify(envelope),
		});

		expect(res.status).toBe(202);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.ingestId).toBe(RUN_ID);
		expect(data.recordCount).toBe(1);
	});

	testOrSkip("run appears in runs list with correct source", async () => {
		await waitForQueueProcessing(6000);

		const res = await fetch(`${ENDPOINTS.core}/internal/runs?limit=20`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.items.length).toBeGreaterThan(0);

		const run = data.items.find((r: { source_id: string }) => r.source_id === SOURCE_ID);
		expect(run).toBeDefined();
		expect(run.status).toMatch(/persisted|normalized|completed|success/);
	});

	testOrSkip("run details contain the original ingestId", async () => {
		const runsRes = await fetch(`${ENDPOINTS.core}/internal/runs?limit=20`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});
		const runsData = await runsRes.json();
		const run = runsData.items.find((r: { source_id: string }) => r.source_id === SOURCE_ID);
		expect(run).toBeDefined();

		const detailRes = await fetch(`${ENDPOINTS.core}/internal/runs/${run.run_id}`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});

		expect(detailRes.status).toBe(200);
		const detail = await detailRes.json();
		expect(detail.source_id).toBe(SOURCE_ID);
		expect(detail.ingest_id).toBe(RUN_ID);
	});

	testOrSkip("raw artifact exists in R2", async () => {
		const runsRes = await fetch(`${ENDPOINTS.core}/internal/runs?limit=20`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});
		const runsData = await runsRes.json();
		const run = runsData.items.find((r: { source_id: string }) => r.source_id === SOURCE_ID);
		expect(run).toBeDefined();

		const artifactsRes = await fetch(`${ENDPOINTS.core}/internal/runs/${run.run_id}/artifacts`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});

		expect(artifactsRes.status).toBe(200);
		const artifacts = await artifactsRes.json();
		expect(artifacts.artifacts.length).toBeGreaterThan(0);
		expect(artifacts.artifacts[0].artifact_key).toContain(SOURCE_ID);
	});

	testOrSkip("entity was created and is queryable", async () => {
		// Give a bit more time for normalization
		await waitForQueueProcessing(3000);

		const entitiesRes = await fetch(
			`${ENDPOINTS.core}/internal/entities?sourceId=${SOURCE_ID}&limit=10`,
			{
				headers: { "x-uplink-internal-key": INTERNAL_KEY! },
			},
		);

		expect(entitiesRes.status).toBe(200);
		const entities = await entitiesRes.json();
		expect(entities.items.length).toBeGreaterThan(0);

		const entity = entities.items.find(
			(e: { external_id: string }) => e.external_id === `ext-${RUN_ID}`,
		);
		expect(entity).toBeDefined();
		expect(entity.source_id).toBe(SOURCE_ID);
	});

	testOrSkip("metrics reflect the new source and run", async () => {
		const metricsRes = await fetch(`${ENDPOINTS.core}/internal/metrics/sources?limit=50`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});

		expect(metricsRes.status).toBe(200);
		const metrics = await metricsRes.json();
		expect(metrics.items).toBeInstanceOf(Array);

		const sourceMetric = metrics.items.find(
			(m: { sourceId: string }) => m.sourceId === SOURCE_ID,
		);
		expect(sourceMetric).toBeDefined();
		expect(sourceMetric.totalRuns).toBeGreaterThanOrEqual(1);
	});

	testOrSkip("dashboard v2 API includes the test source", async () => {
		const res = await fetch(`${ENDPOINTS.core}/internal/dashboard/v2?window=3600`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.summary).toBeDefined();
		expect(data.sources).toBeInstanceOf(Array);

		const sourceEntry = data.sources.find(
			(s: { sourceId: string }) => s.sourceId === SOURCE_ID,
		);
		expect(sourceEntry).toBeDefined();
	});

	testOrSkip("source health endpoint shows runtime state", async () => {
		const res = await fetch(`${ENDPOINTS.core}/internal/sources/${SOURCE_ID}/health`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.config.sourceId).toBe(SOURCE_ID);
		expect(data.runtime).toBeDefined();
	});

	testOrSkip("cleanup: soft-deletes test source", async () => {
		const res = await fetch(`${ENDPOINTS.core}/internal/sources/${SOURCE_ID}`, {
			method: "DELETE",
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
	});
});

describe("Live Data Flow - Error Path", () => {
	beforeAll(() => {
		if (!hasCredentials) {
			console.log("Skipping live error path tests — no credentials");
		}
	});

	testOrSkip("rejects ingest without auth", async () => {
		const res = await fetch(`${ENDPOINTS.edge}/v1/intake`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ test: true }),
		});
		expect(res.status).toBe(401);
	});

	testOrSkip("rejects invalid envelope schema", async () => {
		const res = await fetch(`${ENDPOINTS.edge}/v1/intake`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"authorization": `Bearer ${INGEST_KEY}`,
			},
			body: JSON.stringify({ invalid: true }),
		});
		expect(res.status).toBe(400);
	});

	testOrSkip("rejects ingest for non-existent source", async () => {
		const envelope = {
			schemaVersion: "1.0",
			ingestId: `reject-${Date.now()}`,
			sourceId: "definitely-does-not-exist-12345",
			sourceName: "Missing Source",
			sourceType: "api",
			collectedAt: new Date().toISOString(),
			records: [
				{
					contentHash: `hash-${Date.now()}`,
					rawPayload: { test: true },
				},
			],
		};

		const res = await fetch(`${ENDPOINTS.edge}/v1/intake`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"authorization": `Bearer ${INGEST_KEY}`,
			},
			body: JSON.stringify(envelope),
		});

		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toContain("not found");
	});
});

describe("Live Data Flow - Browser Collection", () => {
	beforeAll(() => {
		if (!hasCredentials) {
			console.log("Skipping live browser tests — no credentials");
		}
	});

	testOrSkip("browser collect requires auth", async () => {
		const res = await fetch(`${ENDPOINTS.core}/internal/browser/collect`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sourceId: "x", url: "https://example.com" }),
		});
		expect(res.status).toBe(401);
	});

	testOrSkip("browser collect validates URLs", async () => {
		const res = await fetch(`${ENDPOINTS.core}/internal/browser/collect`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-uplink-internal-key": INTERNAL_KEY!,
			},
			body: JSON.stringify({ sourceId: "x", url: "not-a-url" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("Live Data Flow - Metrics Endpoints", () => {
	beforeAll(() => {
		if (!hasCredentials) {
			console.log("Skipping live metrics tests — no credentials");
		}
	});

	testOrSkip("queue metrics return structured data", async () => {
		const res = await fetch(`${ENDPOINTS.core}/internal/metrics/queue`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.pending).toBeDefined();
		expect(data.processing).toBeDefined();
		expect(data.lagMinutes).toBeDefined();
	});

	testOrSkip("system metrics return structured data", async () => {
		const res = await fetch(`${ENDPOINTS.core}/internal/metrics/system`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.sources).toBeDefined();
		expect(data.runs24h).toBeDefined();
		expect(data.artifacts).toBeDefined();
	});

	testOrSkip("entity metrics return structured data", async () => {
		const res = await fetch(`${ENDPOINTS.core}/internal/metrics/entities`, {
			headers: { "x-uplink-internal-key": INTERNAL_KEY! },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.totalEntities).toBeDefined();
		expect(data.newToday).toBeDefined();
	});
});
