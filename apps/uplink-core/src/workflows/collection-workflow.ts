import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import {
	CollectionWorkflowParamsSchema,
	createIngestQueueMessage,
	toIsoNow,
	type CollectionWorkflowParams,
	type IngestEnvelope,
} from "@uplink/contracts";
import { createSourceAdapter } from "@uplink/source-adapters";
import type { Env } from "../types";
import { getCoordinatorStub, recordCoordinatorFailure, recordCoordinatorSuccess } from "../lib/coordinator-client";
import { getSourceConfigWithPolicy, setRunStatus, upsertRuntimeSnapshot } from "../lib/db";
import { writeMetric } from "../lib/metrics";

export class CollectionWorkflow extends WorkflowEntrypoint<Env, CollectionWorkflowParams> {
	async run(event: WorkflowEvent<CollectionWorkflowParams>): Promise<{
		runId: string;
		sourceId: string;
		recordCount: number;
	}> {
		const payload = CollectionWorkflowParamsSchema.parse(event.payload);
		const runId = `collect:${payload.sourceId}:${event.instanceId}`;
		const coordinator = getCoordinatorStub(this.env, payload.sourceId);

		const sourceLookup = await getSourceConfigWithPolicy(this.env.CONTROL_DB, payload.sourceId);
		if (!sourceLookup) {
			throw new Error(`Unknown source: ${payload.sourceId}`);
		}

		if (sourceLookup.config.status !== "active" && !payload.force) {
			throw new Error(`Source ${payload.sourceId} is not active`);
		}

		try {
			await setRunStatus(this.env.CONTROL_DB, runId, "collecting", {
				workflowInstanceId: event.instanceId,
			});

			const adapter = createSourceAdapter(sourceLookup.config.type);
			const adapterResult = await adapter.collect(
				{
					sourceId: sourceLookup.config.sourceId,
					sourceName: sourceLookup.config.name,
					sourceType: sourceLookup.config.type,
					endpointUrl: sourceLookup.config.endpointUrl,
					requestMethod: sourceLookup.config.requestMethod,
					requestHeaders: sourceLookup.config.requestHeaders,
					requestBody: sourceLookup.config.requestBody,
					cursor: undefined,
					metadata: sourceLookup.config.metadata,
				},
				{
					fetchFn: fetch,
					browserFetcher: this.env.UPLINK_BROWSER,
					nowIso: toIsoNow,
				},
			);

			const boundedRecords = adapterResult.records.slice(0, sourceLookup.policy.maxRecordsPerRun);

			const envelope: IngestEnvelope = {
				schemaVersion: "1.0",
				ingestId: runId,
				sourceId: sourceLookup.config.sourceId,
				sourceName: sourceLookup.config.name,
				sourceType: sourceLookup.config.type,
				collectedAt: toIsoNow(),
				records: boundedRecords,
				hasMore: adapterResult.hasMore,
				nextCursor: adapterResult.nextCursor,
				traceId: event.instanceId,
				metadata: {
					triggeredBy: payload.triggeredBy,
					reason: payload.reason,
					workflowInstanceId: event.instanceId,
				},
			};

			await this.env.INGEST_QUEUE.send(
				createIngestQueueMessage(envelope, {
					requestId: event.instanceId,
				}),
			);

			const snapshot = await recordCoordinatorSuccess(coordinator, {
				leaseToken: payload.leaseToken,
				runId,
				cursor: adapterResult.nextCursor,
			});
			await upsertRuntimeSnapshot(this.env.CONTROL_DB, snapshot);

			await setRunStatus(this.env.CONTROL_DB, runId, "enqueued", {
				workflowInstanceId: event.instanceId,
			});

			writeMetric(this.env, {
				sourceId: sourceLookup.config.sourceId,
				sourceType: sourceLookup.config.type,
				event: "workflow.enqueued",
				value: boundedRecords.length,
				index: runId,
			});

			return {
				runId,
				sourceId: payload.sourceId,
				recordCount: boundedRecords.length,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Collection workflow failed";
			
			// Graceful degradation: Always try to record failure, but don't let it break the workflow
			let failureRecorded = false;
			try {
				const snapshot = await recordCoordinatorFailure(coordinator, {
					leaseToken: payload.leaseToken,
					runId,
					errorMessage,
				});
				await upsertRuntimeSnapshot(this.env.CONTROL_DB, snapshot);
				failureRecorded = true;
			} catch (coordinatorError) {
				// Log but don't throw - we still want to record the run failure
				console.warn("[CollectionWorkflow] Coordinator failure recording failed, continuing", {
					runId,
					sourceId: payload.sourceId,
					error: coordinatorError instanceof Error ? coordinatorError.message : String(coordinatorError),
				});
			}

			// Always try to update run status, even if coordinator update failed
			try {
				await setRunStatus(this.env.CONTROL_DB, runId, "failed", {
					errorMessage,
					workflowInstanceId: event.instanceId,
				});
			} catch (dbError) {
				console.error("[CollectionWorkflow] Failed to update run status", {
					runId,
					error: dbError instanceof Error ? dbError.message : String(dbError),
				});
			}

			writeMetric(this.env, {
				sourceId: sourceLookup.config.sourceId,
				sourceType: sourceLookup.config.type,
				event: "workflow.failed",
				value: 1,
				index: runId,
			});

			// Re-throw original error to trigger workflow retry
			throw error;
		}
	}
}
