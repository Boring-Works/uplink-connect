/**
 * Live End-to-End Test
 * 
 * This test exercises the FULL production pipeline:
 * 1. Creates a source config
 * 2. Ingests data through the edge API
 * 3. Verifies queue processing
 * 4. Queries the resulting entity
 * 5. Checks metrics and health
 * 
 * Run: cd apps/uplink-core && pnpm vitest run --config vitest.live.config.ts
 * 
 * NOTE: This requires valid auth credentials for the production deployment.
 * Set them as environment variables:
 * - UPLINK_LIVE_INGEST_API_KEY
 * - UPLINK_LIVE_INTERNAL_KEY
 * - UPLINK_LIVE_OPS_API_KEY
 */

import { describe, it, expect, beforeAll } from "vitest";

const ENDPOINTS = {
	edge: "https://uplink-edge.codyboring.workers.dev",
	core: "https://uplink-core.codyboring.workers.dev",
	ops: "https://uplink-ops.codyboring.workers.dev",
	browser: "https://uplink-browser.codyboring.workers.dev",
};

// Get credentials from environment
const INGEST_KEY = process.env.UPLINK_LIVE_INGEST_API_KEY;
const INTERNAL_KEY = process.env.UPLINK_LIVE_INTERNAL_KEY;
const OPS_KEY = process.env.UPLINK_LIVE_OPS_API_KEY;

const hasCredentials = !!(INGEST_KEY && INTERNAL_KEY && OPS_KEY);

// Generate unique IDs for this test run
const TEST_SOURCE_ID = `live-test-source-${Date.now()}`;
const TEST_INGEST_ID = `live-test-ingest-${Date.now()}`;

// Skip live tests if credentials aren't available
const testOrSkip = hasCredentials ? it : it.skip;

describe("Live E2E - Full Pipeline Test", () => {
	beforeAll(() => {
		if (!hasCredentials) {
			console.log("Skipping live tests - no credentials provided");
			console.log("Set UPLINK_LIVE_INGEST_API_KEY, UPLINK_LIVE_INTERNAL_KEY, and UPLINK_LIVE_OPS_API_KEY");
		}
	});

	describe("Phase 1: Health Checks", () => {
		testOrSkip("all workers respond to health checks", async () => {
			const results = await Promise.all([
				fetch(`${ENDPOINTS.edge}/health`),
				fetch(`${ENDPOINTS.core}/health`),
				fetch(`${ENDPOINTS.ops}/health`),
				fetch(`${ENDPOINTS.browser}/health`),
			]);

			for (const response of results) {
				expect(response.status).toBe(200);
				const data = await response.json();
				expect(data.ok).toBe(true);
			}
		});
	});

	describe("Phase 2: Source Configuration", () => {
		testOrSkip("creates a test source", async () => {
			const sourceConfig = {
				sourceId: TEST_SOURCE_ID,
				name: "Live Test Source",
				type: "api",
				status: "active",
				adapterType: "generic-api",
				endpointUrl: "https://httpbin.org/get",
				requestMethod: "GET",
				requestHeaders: {},
				metadata: { testRun: true },
				policy: {
					minIntervalSeconds: 10,
					leaseTtlSeconds: 60,
					maxRecordsPerRun: 100,
					retryLimit: 2,
					timeoutSeconds: 30,
				},
			};

			const response = await fetch(`${ENDPOINTS.core}/internal/sources`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-uplink-internal-key": INTERNAL_KEY!,
				},
				body: JSON.stringify(sourceConfig),
			});

			expect(response.status).toBe(200);
		});

		testOrSkip("retrieves the created source", async () => {
			const response = await fetch(
				`${ENDPOINTS.core}/internal/sources/${TEST_SOURCE_ID}`,
				{
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.config.sourceId).toBe(TEST_SOURCE_ID);
			expect(data.config.status).toBe("active");
		});
	});

	describe("Phase 3: Data Ingestion", () => {
		testOrSkip("ingests data through edge API", async () => {
			const envelope = {
				schemaVersion: "1.0",
				ingestId: TEST_INGEST_ID,
				sourceId: TEST_SOURCE_ID,
				sourceName: "Live Test Source",
				sourceType: "api",
				collectedAt: new Date().toISOString(),
				records: [
					{
						externalId: `record-${Date.now()}`,
						contentHash: `hash-${Date.now()}`,
						rawPayload: {
							name: "Test Entity",
							value: 42,
							tags: ["live-test", "e2e"],
						},
						observedAt: new Date().toISOString(),
					},
				],
			};

			const response = await fetch(`${ENDPOINTS.edge}/v1/intake`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"authorization": `Bearer ${INGEST_KEY}`,
				},
				body: JSON.stringify(envelope),
			});

			expect(response.status).toBe(202);
			const data = await response.json();
			expect(data.ok).toBe(true);
			expect(data.ingestId).toBe(TEST_INGEST_ID);
			expect(data.recordCount).toBe(1);
		});

		testOrSkip("ingest is idempotent", async () => {
			const envelope = {
				schemaVersion: "1.0",
				ingestId: TEST_INGEST_ID,
				sourceId: TEST_SOURCE_ID,
				sourceName: "Live Test Source",
				sourceType: "api",
				collectedAt: new Date().toISOString(),
				records: [
					{
						externalId: `record-${Date.now()}`,
						contentHash: `hash-${Date.now()}`,
						rawPayload: { name: "Duplicate Test" },
					},
				],
			};

			const response = await fetch(`${ENDPOINTS.edge}/v1/intake`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"authorization": `Bearer ${INGEST_KEY}`,
				},
				body: JSON.stringify(envelope),
			});

			// Should still accept but processing will deduplicate
			expect(response.status).toBe(202);
		});
	});

	describe("Phase 4: Processing Verification", () => {
		testOrSkip("run appears in runs list after processing", async () => {
			// Wait for queue processing
			await new Promise((resolve) => setTimeout(resolve, 5000));

			const response = await fetch(
				`${ENDPOINTS.core}/internal/runs?limit=10`,
				{
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.items.length).toBeGreaterThan(0);
			
			const run = data.items.find((r: { source_id: string }) => r.source_id === TEST_SOURCE_ID);
			expect(run).toBeDefined();
		});

		testOrSkip("can retrieve specific run details", async () => {
			const runsResponse = await fetch(
				`${ENDPOINTS.core}/internal/runs?limit=10`,
				{
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);
			const runsData = await runsResponse.json();
			const run = runsData.items.find((r: { source_id: string }) => r.source_id === TEST_SOURCE_ID);
			
			expect(run).toBeDefined();
			
			const detailResponse = await fetch(
				`${ENDPOINTS.core}/internal/runs/${run.run_id}`,
				{
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);

			expect(detailResponse.status).toBe(200);
			const detail = await detailResponse.json();
			expect(detail.source_id).toBe(TEST_SOURCE_ID);
		});
	});

	describe("Phase 5: Observability", () => {
		testOrSkip("dashboard v2 API returns data", async () => {
			const response = await fetch(
				`${ENDPOINTS.core}/internal/dashboard/v2?window=3600`,
				{
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.timestamp).toBeDefined();
			expect(data.summary).toBeDefined();
			expect(data.pipeline).toBeDefined();
			expect(data.components).toBeDefined();
		});

		testOrSkip("pipeline topology is available", async () => {
			const response = await fetch(
				`${ENDPOINTS.core}/internal/health/topology`,
				{
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.stages).toBeDefined();
			expect(data.stages.length).toBeGreaterThan(0);
			expect(data.connections).toBeDefined();
			expect(data.overallHealth).toBeDefined();
		});

		testOrSkip("source health timeline is available", async () => {
			const response = await fetch(
				`${ENDPOINTS.core}/internal/sources/${TEST_SOURCE_ID}/health/timeline?window=3600`,
				{
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.sourceId).toBe(TEST_SOURCE_ID);
			expect(data.intervals).toBeDefined();
		});
	});

	describe("Phase 6: HTML Dashboard", () => {
		testOrSkip("HTML dashboard renders without errors", async () => {
			const response = await fetch(`${ENDPOINTS.core}/dashboard`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/html");
			
			const html = await response.text();
			expect(html).toContain("Uplink Connect");
			expect(html).not.toContain("Dashboard Error");
		});
	});

	describe("Phase 7: Cleanup", () => {
		testOrSkip("soft-deletes test source", async () => {
			const response = await fetch(
				`${ENDPOINTS.core}/internal/sources/${TEST_SOURCE_ID}`,
				{
					method: "DELETE",
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.ok).toBe(true);
		});

		testOrSkip("test source no longer appears in default list", async () => {
			const response = await fetch(
				`${ENDPOINTS.core}/internal/sources`,
				{
					headers: {
						"x-uplink-internal-key": INTERNAL_KEY!,
					},
				},
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			const found = data.items.find((s: { source_id: string }) => s.source_id === TEST_SOURCE_ID);
			expect(found).toBeUndefined();
		});
	});
});

describe("Live E2E - Ops Proxy", () => {
	const testOrSkip = hasCredentials ? it : it.skip;

	testOrSkip("ops dashboard proxy works", async () => {
		const response = await fetch(`${ENDPOINTS.ops}/v1/dashboard`, {
			headers: {
				"authorization": `Bearer ${OPS_KEY}`,
			},
		});

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.timestamp).toBeDefined();
	});

	testOrSkip("ops HTML dashboard proxy works", async () => {
		const response = await fetch(`${ENDPOINTS.ops}/dashboard`, {
			headers: {
				"authorization": `Bearer ${OPS_KEY}`,
			},
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
	});
});
