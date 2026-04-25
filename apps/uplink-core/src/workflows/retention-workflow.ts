import { WorkflowEntrypoint, type WorkflowEvent } from "cloudflare:workers";
import {
	RetentionWorkflowParamsSchema,
	toIsoNow,
	ulid,
	type RetentionWorkflowParams,
} from "@uplink/contracts";
import type { Env } from "../types";
import { writeMetric } from "../lib/metrics";

interface RetentionResult {
	workflowId: string;
	dryRun: boolean;
	retentionDays: number;
	cutoffDate: string;
	stats: {
		runsArchived: number;
		artifactsDeleted: number;
		observationsDeleted: number;
		errors: number;
	};
	completedAt: string;
}

interface RunToArchive {
	runId: string;
	sourceId: string;
	artifactKey: string | null;
}

interface ArtifactToDelete {
	artifactId: string;
	r2Key: string;
	runId: string;
}

export class RetentionWorkflow extends WorkflowEntrypoint<Env, RetentionWorkflowParams> {
	async run(event: WorkflowEvent<RetentionWorkflowParams>): Promise<RetentionResult> {
		const payload = RetentionWorkflowParamsSchema.parse(event.payload);
		const workflowId = event.instanceId;

		// Calculate cutoff date based on retention policy
		const retentionDays = payload.retentionDays ?? 90;
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
		const cutoffIso = cutoffDate.toISOString();

		const result: RetentionResult = {
			workflowId,
			dryRun: payload.dryRun ?? false,
			retentionDays,
			cutoffDate: cutoffIso,
			stats: {
				runsArchived: 0,
				artifactsDeleted: 0,
				observationsDeleted: 0,
				errors: 0,
			},
			completedAt: "",
		};

		console.log(`[RetentionWorkflow ${workflowId}] Starting retention cleanup`, {
			dryRun: result.dryRun,
			retentionDays,
			cutoffDate: cutoffIso,
			triggeredBy: payload.triggeredBy,
		});

		try {
			// Step 1: Find runs older than retention period
			const runsToArchive = await this.findRunsToArchive(cutoffIso, payload.batchSize);
			console.log(`[RetentionWorkflow ${workflowId}] Found ${runsToArchive.length} runs to archive`);

			// Step 2: Find associated artifacts in R2
			const artifactsToDelete = await this.findArtifactsForRuns(runsToArchive.map(r => r.runId));
			console.log(`[RetentionWorkflow ${workflowId}] Found ${artifactsToDelete.length} artifacts to delete`);

			// Step 3: Delete R2 artifacts (with partial failure handling)
			if (!result.dryRun && artifactsToDelete.length > 0) {
				const deleteResults = await this.deleteR2Artifacts(artifactsToDelete);
				result.stats.artifactsDeleted = deleteResults.deleted;
				result.stats.errors += deleteResults.errors;
			} else if (result.dryRun) {
				console.log(`[RetentionWorkflow ${workflowId}] DRY RUN: Would delete ${artifactsToDelete.length} artifacts`);
			}

			// Step 4: Soft-delete/archive run records
			if (!result.dryRun && runsToArchive.length > 0) {
				const archiveResults = await this.archiveRuns(runsToArchive.map(r => r.runId));
				result.stats.runsArchived = archiveResults.archived;
				result.stats.errors += archiveResults.errors;
			} else if (result.dryRun) {
				console.log(`[RetentionWorkflow ${workflowId}] DRY RUN: Would archive ${runsToArchive.length} runs`);
			}

			// Step 5: Clean up entity observations older than retention
			const observationCleanup = await this.cleanupObservations(cutoffIso, result.dryRun);
			result.stats.observationsDeleted = observationCleanup.deleted;
			result.stats.errors += observationCleanup.errors;

			// Log completion
			result.completedAt = toIsoNow();
			console.log(`[RetentionWorkflow ${workflowId}] Completed retention cleanup`, {
				stats: result.stats,
				completedAt: result.completedAt,
			});

			// Write metrics
			writeMetric(this.env, {
				sourceId: "retention",
				sourceType: "system",
				event: "retention.completed",
				value: result.stats.runsArchived + result.stats.artifactsDeleted + result.stats.observationsDeleted,
				index: workflowId,
			});

			return result;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Retention workflow failed";
			console.error(`[RetentionWorkflow ${workflowId}] Failed:`, errorMessage);

			writeMetric(this.env, {
				sourceId: "retention",
				sourceType: "system",
				event: "retention.failed",
				value: 1,
				index: workflowId,
			});

			throw error;
		}
	}

	/**
	 * Find runs older than the cutoff date that haven't been archived yet.
	 * Only processes runs that are in a terminal state (not 'collecting', 'enqueued').
	 */
	private async findRunsToArchive(cutoffIso: string, batchSize = 1000): Promise<RunToArchive[]> {
		const result = await this.env.CONTROL_DB.prepare(
			`SELECT 
				r.run_id,
				r.source_id,
				r.artifact_key
			FROM ingest_runs r
			WHERE r.received_at < ?
				AND r.status NOT IN ('collecting', 'enqueued')
				AND r.run_id NOT IN (
					SELECT run_id FROM retention_audit_log WHERE action = 'archived'
				)
			ORDER BY r.received_at ASC
			LIMIT ?`
		)
			.bind(cutoffIso, batchSize)
			.all<{ run_id: string; source_id: string; artifact_key: string | null }>();

		return result.results.map(row => ({
			runId: row.run_id,
			sourceId: row.source_id,
			artifactKey: row.artifact_key,
		}));
	}

	/**
	 * Find all artifacts associated with the given run IDs.
	 */
	private async findArtifactsForRuns(runIds: string[]): Promise<ArtifactToDelete[]> {
		if (runIds.length === 0) return [];

		// Build placeholders for IN clause
		const placeholders = runIds.map(() => "?").join(",");
		
		const result = await this.env.CONTROL_DB.prepare(
			`SELECT artifact_id, r2_key, run_id
			FROM raw_artifacts
			WHERE run_id IN (${placeholders})`
		)
			.bind(...runIds)
			.all<{ artifact_id: string; r2_key: string; run_id: string }>();

		return result.results.map(row => ({
			artifactId: row.artifact_id,
			r2Key: row.r2_key,
			runId: row.run_id,
		}));
	}

	/**
	 * Delete R2 artifacts with partial failure handling.
	 * Returns count of successfully deleted and errors encountered.
	 */
	private async deleteR2Artifacts(artifacts: ArtifactToDelete[]): Promise<{ deleted: number; errors: number }> {
		let deleted = 0;
		let errors = 0;

		for (const artifact of artifacts) {
			try {
				await this.env.RAW_BUCKET.delete(artifact.r2Key);
				deleted++;

				// Log successful deletion
				await this.logRetentionAction(artifact.runId, "artifact_deleted", {
					artifactId: artifact.artifactId,
					r2Key: artifact.r2Key,
				});
			} catch (error) {
				errors++;
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				console.error(`[RetentionWorkflow] Failed to delete artifact ${artifact.artifactId}:`, errorMessage);

				// Log failure but continue processing
				await this.logRetentionAction(artifact.runId, "artifact_delete_failed", {
					artifactId: artifact.artifactId,
					r2Key: artifact.r2Key,
					error: errorMessage,
				});
			}
		}

		return { deleted, errors };
	}

	/**
	 * Soft-delete/archive runs by marking them in the audit log.
	 * The actual data remains for compliance but is marked as archived.
	 */
	private async archiveRuns(runIds: string[]): Promise<{ archived: number; errors: number }> {
		let archived = 0;
		let errors = 0;

		for (const runId of runIds) {
			try {
				// Insert audit log entry (idempotent - will ignore if already exists)
				await this.env.CONTROL_DB.prepare(
					`INSERT INTO retention_audit_log (
						log_id, run_id, action, details_json, created_at
					) VALUES (?, ?, ?, ?, unixepoch())
					ON CONFLICT(log_id) DO NOTHING`
				)
					.bind(ulid(), runId, "archived", JSON.stringify({ archivedAt: toIsoNow() }))
					.run();

				archived++;
			} catch (error) {
				errors++;
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				console.error(`[RetentionWorkflow] Failed to archive run ${runId}:`, errorMessage);
			}
		}

		return { archived, errors };
	}

	/**
	 * Clean up entity observations older than the retention period.
	 * These can be hard-deleted as they're derived data.
	 */
	private async cleanupObservations(cutoffIso: string, dryRun: boolean): Promise<{ deleted: number; errors: number }> {
		if (dryRun) {
			const count = await this.env.CONTROL_DB.prepare(
				`SELECT COUNT(*) as count FROM entity_observations WHERE observed_at < ?`
			)
				.bind(cutoffIso)
				.first<{ count: number }>();
			
			console.log(`[RetentionWorkflow] DRY RUN: Would delete ${count?.count ?? 0} observations`);
			return { deleted: 0, errors: 0 };
		}

		try {
			// Delete observations in batches to avoid locking
			const batchSize = 1000;
			let totalDeleted = 0;
			let hasMore = true;

			while (hasMore) {
				const result = await this.env.CONTROL_DB.prepare(
					`DELETE FROM entity_observations 
					WHERE observation_id IN (
						SELECT observation_id 
						FROM entity_observations 
						WHERE observed_at < ?
						LIMIT ?
					)`
				)
					.bind(cutoffIso, batchSize)
					.run();

				const deleted = result.meta?.changes ?? 0;
				totalDeleted += deleted;
				hasMore = deleted >= batchSize;
			}

			console.log(`[RetentionWorkflow] Deleted ${totalDeleted} observations`);
			return { deleted: totalDeleted, errors: 0 };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			console.error("[RetentionWorkflow] Failed to cleanup observations:", errorMessage);
			return { deleted: 0, errors: 1 };
		}
	}

	/**
	 * Log a retention action for audit purposes.
	 */
	private async logRetentionAction(
		runId: string,
		action: string,
		details: Record<string, unknown>
	): Promise<void> {
		try {
			await this.env.CONTROL_DB.prepare(
				`INSERT INTO retention_audit_log (
					log_id, run_id, action, details_json, created_at
				) VALUES (?, ?, ?, ?, unixepoch())`
			)
				.bind(ulid(), runId, action, JSON.stringify(details))
				.run();
		} catch (error) {
			// Non-fatal: log to console but don't fail the workflow
			console.error(`[RetentionWorkflow] Failed to log action ${action} for run ${runId}:`, error);
		}
	}
}
