import { describe, it, expect, vi, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { createIngestQueueMessage } from "@uplink/contracts";
import { handleIngestMessage } from "../../lib/processing";
import type { Env as CoreEnv } from "../../types";

// E2E tests use SELF.fetch to test full request flows through the worker.

describe("e2e flows", () => {
	let coreEnv: CoreEnv;

	beforeEach(() => {
		coreEnv = env as unknown as CoreEnv;
		vi.clearAllMocks();
	});

	describe("health endpoint", () => {
		it("returns health status from core worker", async () => {
			const response = await SELF.fetch("http://localhost/health");
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toHaveProperty("ok", expect.any(Boolean));
			expect(body).toHaveProperty("service", "uplink-core");
			expect(body).toHaveProperty("status", expect.any(String));
			expect(body).toHaveProperty("components", expect.any(Array));
		});
	});

	describe("internal dashboard", () => {
		it("returns dashboard data", async () => {
			const response = await SELF.fetch("http://localhost/internal/dashboard", {
				headers: { "x-uplink-internal-key": coreEnv.CORE_INTERNAL_KEY },
			});
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toHaveProperty("summary");
			expect(body).toHaveProperty("system");
			expect(body).toHaveProperty("queue");
			expect(body).toHaveProperty("entities");
			expect(body).toHaveProperty("activeAlerts");
		});
	});

	describe("source registration and trigger flow", () => {
		it("registers a source and triggers a collection run", async () => {
			const sourceId = `e2e-src-${Date.now()}`;
			const internalKey = coreEnv.CORE_INTERNAL_KEY;

			// 1. Register source
			const registerRes = await SELF.fetch("http://localhost/internal/sources", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-uplink-internal-key": internalKey,
				},
				body: JSON.stringify({
					sourceId,
					name: "E2E Test Source",
					type: "api",
					adapterType: "api",
					endpointUrl: "https://example.com/api",
					policy: {
						leaseTtlSeconds: 60,
						minIntervalSeconds: 1,
						maxRecordsPerRun: 100,
						retryLimit: 3,
						timeoutSeconds: 60,
					},
				}),
			});
			expect(registerRes.status).toBe(201);

			// 2. Trigger source
			const triggerRes = await SELF.fetch(
				`http://localhost/internal/sources/${sourceId}/trigger`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-uplink-internal-key": internalKey,
					},
					body: JSON.stringify({ triggeredBy: "e2e" }),
				},
			);
			expect([200, 202, 409]).toContain(triggerRes.status);
		});
	});

	describe("ingest and query flow", () => {
		it("ingests an envelope and queries the run", async () => {
			const runId = `e2e-run-${Date.now()}`;
			const sourceId = `e2e-src-${Date.now()}`;
			const internalKey = coreEnv.CORE_INTERNAL_KEY;

			// Ensure source exists
			await SELF.fetch("http://localhost/internal/sources", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-uplink-internal-key": internalKey,
				},
			body: JSON.stringify({
				sourceId,
				name: "E2E Query Source",
				type: "api",
				adapterType: "api",
				policy: {
					leaseTtlSeconds: 60,
					minIntervalSeconds: 1,
					maxRecordsPerRun: 100,
					retryLimit: 3,
					timeoutSeconds: 60,
				},
			}),
			});

			// Ingest via direct processing (no /internal/ingest endpoint exists)
			const envelope = {
				schemaVersion: "1.0" as const,
				ingestId: runId,
				sourceId,
				sourceName: "E2E Query Source",
				sourceType: "api" as const,
				collectedAt: new Date().toISOString(),
				records: [
					{
						contentHash: "e2e-hash-alice-1234",
						rawPayload: { id: "r1", data: { name: "Alice" } },
					},
				],
				hasMore: false,
			};
			const message = createIngestQueueMessage(envelope, { requestId: `e2e-${runId}` });
			await handleIngestMessage(coreEnv, message);

			// Query run
			const getRes = await SELF.fetch(`http://localhost/internal/runs/${runId}`, {
				headers: { "x-uplink-internal-key": internalKey },
			});
			expect(getRes.status).toBe(200);
			const body = await getRes.json();
			expect(body.run_id).toBe(runId);
		});
	});

	describe("replay flow", () => {
		it("replays an existing run", async () => {
			const runId = `e2e-replay-${Date.now()}`;
			const sourceId = `e2e-src-${Date.now()}`;
			const internalKey = coreEnv.CORE_INTERNAL_KEY;

			// Register
			await SELF.fetch("http://localhost/internal/sources", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-uplink-internal-key": internalKey,
				},
			body: JSON.stringify({
				sourceId,
				name: "Replay Source",
				type: "api",
				adapterType: "api",
				policy: {
					leaseTtlSeconds: 60,
					minIntervalSeconds: 1,
					maxRecordsPerRun: 100,
					retryLimit: 3,
					timeoutSeconds: 60,
				},
			}),
			});

			// Ingest via direct processing
			const envelope = {
				schemaVersion: "1.0" as const,
				ingestId: runId,
				sourceId,
				sourceName: "Replay Source",
				sourceType: "api" as const,
				collectedAt: new Date().toISOString(),
				records: [
					{
						contentHash: "e2e-hash-replay-1234",
						rawPayload: { id: "r1", data: {} },
					},
				],
				hasMore: false,
			};
			const message = createIngestQueueMessage(envelope, { requestId: `e2e-${runId}` });
			await handleIngestMessage(coreEnv, message);

			// Replay
			const replayRes = await SELF.fetch(
				`http://localhost/internal/runs/${runId}/replay`,
				{
					method: "POST",
					headers: { "x-uplink-internal-key": internalKey },
				},
			);
			expect([200, 202, 409]).toContain(replayRes.status);
		});
	});

	describe("browser status endpoint", () => {
		it("returns browser manager status or 502 when unavailable", async () => {
			const res = await SELF.fetch("http://localhost/internal/browser/status", {
				headers: { "x-uplink-internal-key": coreEnv.CORE_INTERNAL_KEY },
			});
			expect([200, 502, 500]).toContain(res.status);
		});
	});
});
