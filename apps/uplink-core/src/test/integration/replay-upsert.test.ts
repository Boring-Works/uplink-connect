import { describe, expect, it } from "vitest";
import { toIsoNow, ulid } from "@uplink/contracts";
import { getRun, insertRunIfMissing } from "../../lib/db";
import { createTestIngestEnvelope } from "./fixtures";
import type { Env } from "../../types";

async function seedRun(env: Env, params: { runId: string; status: string; envelopeJson?: string }) {
	const envelope = createTestIngestEnvelope({
		ingestId: params.runId,
		sourceId: `source-${ulid()}`,
		sourceName: "Replay Test Source",
		recordCount: 1,
	});

	await insertRunIfMissing(env.CONTROL_DB, {
		runId: params.runId,
		sourceId: envelope.sourceId,
		sourceName: envelope.sourceName,
		sourceType: envelope.sourceType,
		status: params.status,
		collectedAt: envelope.collectedAt,
		receivedAt: toIsoNow(),
		recordCount: envelope.records.length,
		envelope,
		triggeredBy: "test",
	});

	if (typeof params.envelopeJson === "string") {
		await env.CONTROL_DB.prepare("UPDATE ingest_runs SET envelope_json = ? WHERE run_id = ?")
			.bind(params.envelopeJson, params.runId)
			.run();
	}

	return envelope;
}

describe("replay and run upsert", () => {
	describe("replay guards", () => {
		it("rejects replay for in-progress runs", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const runId = `run-in-progress-${ulid()}`;
			await seedRun(testEnv, { runId, status: "collecting" });

			const response = await SELF.fetch(`http://localhost/internal/runs/${runId}/replay`, {
				method: "POST",
				headers: {
					"x-uplink-internal-key": "test-key",
				},
			});

			expect(response.status).toBe(409);
			const body = (await response.json()) as { error: string };
			expect(body.error).toContain("still in progress");
		});

		it("rejects replay for placeholder collection records", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const runId = `run-placeholder-${ulid()}`;
			const envelope = createTestIngestEnvelope({
				ingestId: runId,
				sourceId: `source-${ulid()}`,
				sourceName: "Placeholder Source",
				recordCount: 1,
			});
			envelope.metadata = {
				...(envelope.metadata ?? {}),
				placeholder: true,
			};

			await insertRunIfMissing(testEnv.CONTROL_DB, {
				runId,
				sourceId: envelope.sourceId,
				sourceName: envelope.sourceName,
				sourceType: envelope.sourceType,
				status: "normalized",
				collectedAt: envelope.collectedAt,
				receivedAt: toIsoNow(),
				recordCount: envelope.records.length,
				envelope,
				triggeredBy: "test",
			});

			const response = await SELF.fetch(`http://localhost/internal/runs/${runId}/replay`, {
				method: "POST",
				headers: {
					"x-uplink-internal-key": "test-key",
				},
			});

			expect(response.status).toBe(409);
			const body = (await response.json()) as { error: string };
			expect(body.error).toContain("placeholder collection record");
		});

		it("rejects replay when stored envelope is not valid JSON", async () => {
			const { env, SELF } = await import("cloudflare:test");
			const testEnv = env as Env;

			const runId = `run-invalid-json-${ulid()}`;
			await seedRun(testEnv, {
				runId,
				status: "normalized",
				envelopeJson: "not-json",
			});

			const response = await SELF.fetch(`http://localhost/internal/runs/${runId}/replay`, {
				method: "POST",
				headers: {
					"x-uplink-internal-key": "test-key",
				},
			});

			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string };
			expect(body.error).toContain("not valid JSON");
		});
	});

	describe("run conflict upsert", () => {
		it("replaces placeholder envelope for collecting runs", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `source-${ulid()}`;
			const runId = `collect:${sourceId}:${ulid()}`;

			const placeholderEnvelope = createTestIngestEnvelope({
				ingestId: runId,
				sourceId,
				sourceName: "Placeholder Source",
				recordCount: 1,
			});
			placeholderEnvelope.metadata = {
				...(placeholderEnvelope.metadata ?? {}),
				placeholder: true,
			};

			await insertRunIfMissing(testEnv.CONTROL_DB, {
				runId,
				sourceId,
				sourceName: placeholderEnvelope.sourceName,
				sourceType: placeholderEnvelope.sourceType,
				status: "collecting",
				collectedAt: placeholderEnvelope.collectedAt,
				receivedAt: toIsoNow(),
				recordCount: placeholderEnvelope.records.length,
				envelope: placeholderEnvelope,
				triggeredBy: "workflow",
			});

			const realEnvelope = createTestIngestEnvelope({
				ingestId: runId,
				sourceId,
				sourceName: "Real Source",
				recordCount: 2,
			});

			await insertRunIfMissing(testEnv.CONTROL_DB, {
				runId,
				sourceId,
				sourceName: realEnvelope.sourceName,
				sourceType: realEnvelope.sourceType,
				status: "received",
				collectedAt: realEnvelope.collectedAt,
				receivedAt: toIsoNow(),
				recordCount: realEnvelope.records.length,
				envelope: realEnvelope,
				triggeredBy: "queue",
			});

			const run = await getRun(testEnv.CONTROL_DB, runId);
			expect(run).toBeDefined();
			expect(run?.status).toBe("collecting");
			expect(run?.record_count).toBe(2);

			const storedEnvelope = JSON.parse(run?.envelope_json as string) as {
				sourceName: string;
				records: unknown[];
				metadata?: Record<string, unknown>;
			};
			expect(storedEnvelope.sourceName).toBe("Real Source");
			expect(storedEnvelope.records).toHaveLength(2);
			expect(storedEnvelope.metadata?.placeholder).not.toBe(true);
		});

		it("does not overwrite terminal runs", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const sourceId = `source-${ulid()}`;
			const runId = `terminal:${sourceId}:${ulid()}`;

			const originalEnvelope = createTestIngestEnvelope({
				ingestId: runId,
				sourceId,
				sourceName: "Original Source",
				recordCount: 1,
			});

			await insertRunIfMissing(testEnv.CONTROL_DB, {
				runId,
				sourceId,
				sourceName: originalEnvelope.sourceName,
				sourceType: originalEnvelope.sourceType,
				status: "normalized",
				collectedAt: originalEnvelope.collectedAt,
				receivedAt: toIsoNow(),
				recordCount: originalEnvelope.records.length,
				envelope: originalEnvelope,
				triggeredBy: "queue",
			});

			const replacementEnvelope = createTestIngestEnvelope({
				ingestId: runId,
				sourceId,
				sourceName: "Replacement Source",
				recordCount: 3,
			});

			await insertRunIfMissing(testEnv.CONTROL_DB, {
				runId,
				sourceId,
				sourceName: replacementEnvelope.sourceName,
				sourceType: replacementEnvelope.sourceType,
				status: "received",
				collectedAt: replacementEnvelope.collectedAt,
				receivedAt: toIsoNow(),
				recordCount: replacementEnvelope.records.length,
				envelope: replacementEnvelope,
				triggeredBy: "queue",
			});

			const run = await getRun(testEnv.CONTROL_DB, runId);
			expect(run).toBeDefined();
			expect(run?.status).toBe("normalized");
			expect(run?.record_count).toBe(1);

			const storedEnvelope = JSON.parse(run?.envelope_json as string) as {
				sourceName: string;
				records: unknown[];
			};
			expect(storedEnvelope.sourceName).toBe("Original Source");
			expect(storedEnvelope.records).toHaveLength(1);
		});
	});
});
