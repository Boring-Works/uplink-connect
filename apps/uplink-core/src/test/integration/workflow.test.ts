/**
 * Workflow Integration Tests
 *
 * Tests CollectionWorkflow execution
 * Tests source trigger -> workflow -> ingest flow
 */

import { describe, expect, it, beforeEach } from "vitest";
import { toIsoNow, SourceConfigSchema } from "@uplink/contracts";
import { upsertSourceConfig } from "../../lib/db";
import { fetchMock } from "cloudflare:test";
import {
	getCoordinatorStub,
	acquireLease,
	getCoordinatorState,
} from "../../lib/coordinator-client";
import type { Env } from "../../types";

function mockApiData(responseData: unknown) {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	fetchMock
		.get("https://api.example.com")
		.intercept({
			method: "GET",
			path: "/data",
		})
		.reply(200, responseData)
		.persist();
}

async function createTestSource(
	env: Env,
	sourceId: string,
	overrides: {
		status?: "active" | "paused" | "disabled";
		endpointUrl?: string;
	} = {},
) {
	const source = SourceConfigSchema.parse({
		sourceId,
		name: `Test Source ${sourceId}`,
		type: "api",
		status: overrides.status ?? "active",
		adapterType: "generic-api",
		endpointUrl: overrides.endpointUrl ?? "https://api.example.com/data",
		requestMethod: "GET",
		requestHeaders: { "X-Test": "true" },
		metadata: { test: true },
		policy: {
			minIntervalSeconds: 60,
			leaseTtlSeconds: 300,
			maxRecordsPerRun: 100,
			retryLimit: 3,
			timeoutSeconds: 60,
		},
	});

	await upsertSourceConfig(env.CONTROL_DB, source);
	return source;
}

async function waitUntil(
	check: () => Promise<boolean>,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
	const timeoutMs = options.timeoutMs ?? 2000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (await check()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	return false;
}

describe("collection workflow", () => {
	beforeEach(() => {
		mockApiData({
			data: [{ id: "1", name: "Default Test Item", updated: toIsoNow() }],
		});
	});

	describe("workflow execution", () => {
		it("should create workflow instance with valid params", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `test-source-${crypto.randomUUID()}`;
			await createTestSource(testEnv, sourceId);

			const coordinator = getCoordinatorStub(testEnv, sourceId);
			const lease = await acquireLease(coordinator, {
				requestedBy: "test-runner",
				ttlSeconds: 300,
			});

			expect(lease.acquired).toBe(true);
			expect(lease.leaseToken).toBeDefined();

			// Verify we can create a workflow instance
			const instance = await testEnv.COLLECTION_WORKFLOW.create({
				params: {
					sourceId,
					leaseToken: lease.leaseToken!,
					triggeredBy: "test-runner",
					reason: "integration test",
				},
			});

			expect(instance).toBeDefined();
			expect(instance.id).toBeDefined();
		});
	});

	describe("source trigger flow", () => {
		it("should trigger source collection through API", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `trigger-source-${crypto.randomUUID()}`;
			await createTestSource(testEnv, sourceId);

			mockApiData({
				data: [
					{ id: "1", name: "Item 1", updated: toIsoNow() },
					{ id: "2", name: "Item 2", updated: toIsoNow() },
				],
			});

			// Trigger collection via internal API
			const response = await SELF.fetch(
				`http://localhost/internal/sources/${sourceId}/trigger`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-uplink-internal-key": "test-key",
					},
					body: JSON.stringify({
						triggeredBy: "test-runner",
						reason: "integration test",
					}),
				},
			);

			// Should return 202 Accepted (async workflow started)
			expect(response.status).toBe(202);

			const result = await response.json();
			expect(result.ok).toBe(true);
			expect(result.sourceId).toBe(sourceId);
			expect(result.runId).toBeDefined();
			expect(result.workflowId).toBeDefined();
		});

		it("should reject trigger for non-existent source", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `nonexistent-${crypto.randomUUID()}`;

			const response = await SELF.fetch(
				`http://localhost/internal/sources/${sourceId}/trigger`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-uplink-internal-key": "test-key",
					},
					body: JSON.stringify({
						triggeredBy: "test-runner",
					}),
				},
			);

			expect(response.status).toBe(404);
			const result = await response.json();
			expect(result.error).toContain("not found");
		});

		it("should reject trigger for paused source without force", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `paused-source-${crypto.randomUUID()}`;
			await createTestSource(testEnv, sourceId, { status: "paused" });

			const response = await SELF.fetch(
				`http://localhost/internal/sources/${sourceId}/trigger`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-uplink-internal-key": "test-key",
					},
					body: JSON.stringify({
						triggeredBy: "test-runner",
					}),
				},
			);

			expect(response.status).toBe(409);
			const result = await response.json();
			expect(result.error).toContain("paused");
		});

		it("should allow forced trigger for paused source", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `paused-force-${crypto.randomUUID()}`;
			await createTestSource(testEnv, sourceId, { status: "paused" });

			mockApiData({
				data: [{ id: "1", name: "Item 1" }],
			});

			const response = await SELF.fetch(
				`http://localhost/internal/sources/${sourceId}/trigger`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-uplink-internal-key": "test-key",
					},
					body: JSON.stringify({
						triggeredBy: "test-runner",
						force: true,
					}),
				},
			);

			expect(response.status).toBe(202);
			const result = await response.json();
			expect(result.ok).toBe(true);

			const coordinator = getCoordinatorStub(testEnv, sourceId);
			const leaseReleased = await waitUntil(async () => {
				const state = await getCoordinatorState(coordinator);
				return !state.leaseToken;
			});
			expect(leaseReleased).toBe(true);
		});
	});

	describe("coordinator integration", () => {
		it("should acquire lease before triggering workflow", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `lease-test-${crypto.randomUUID()}`;
			await createTestSource(testEnv, sourceId);

			// Check initial state
			const coordinator = getCoordinatorStub(testEnv, sourceId);
			const initialState = await getCoordinatorState(coordinator);
			expect(initialState.leaseToken).toBeUndefined();

			mockApiData({
				data: [{ id: "1", name: "Item 1" }],
			});

			// Trigger should acquire lease
			await SELF.fetch(
				`http://localhost/internal/sources/${sourceId}/trigger`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-uplink-internal-key": "test-key",
					},
					body: JSON.stringify({
						triggeredBy: "test-runner",
					}),
				},
			);

			const leaseReleased = await waitUntil(async () => {
				const state = await getCoordinatorState(coordinator);
				return !state.leaseToken;
			});
			expect(leaseReleased).toBe(true);
		});

		it("should reject concurrent trigger attempts", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `concurrent-${crypto.randomUUID()}`;
			await createTestSource(testEnv, sourceId);

			// Acquire lease first to simulate an already-running collection
			const coordinator = getCoordinatorStub(testEnv, sourceId);
			const lease = await acquireLease(coordinator, {
				requestedBy: "test-runner-1",
				ttlSeconds: 60,
			});
			expect(lease.acquired).toBe(true);

			mockApiData({
				data: [{ id: "1", name: "Item 1" }],
			});

			// Trigger should fail due to active lease
			const response = await SELF.fetch(
				`http://localhost/internal/sources/${sourceId}/trigger`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-uplink-internal-key": "test-key",
					},
					body: JSON.stringify({
						triggeredBy: "test-runner-2",
					}),
				},
			);

			expect(response.status).toBe(409);
			const result = await response.json();
			expect(
				result.error?.includes("Lease") || result.error?.includes("Rate limited"),
			).toBe(true);
		});
	});
});
