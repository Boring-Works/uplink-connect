import type { SourceConfig, SourcePolicy } from "@uplink/contracts";
import type { SourceCoordinator } from "./durable/source-coordinator";
import type { BrowserManagerDO } from "./durable/browser-manager";

// Pipeline is in beta - using generic interface until types are available
interface Pipeline {
	send(event: unknown): Promise<void>;
}

export type Env = {
	CONTROL_DB: D1Database;
	RAW_BUCKET: R2Bucket;
	ENTITY_INDEX: VectorizeIndex;
	OPS_METRICS: AnalyticsEngineDataset;
	AI: Ai;
	DLQ: Queue;
	INGEST_QUEUE: Queue;
	UPLINK_BROWSER: Fetcher;
	SOURCE_COORDINATOR: DurableObjectNamespace<SourceCoordinator>;
	BROWSER_MANAGER: DurableObjectNamespace<BrowserManagerDO>;
	COLLECTION_WORKFLOW: Workflow;
	RETENTION_WORKFLOW: Workflow;
	CORE_INTERNAL_KEY?: string;
	BROWSER_API_KEY?: string;
	SLACK_WEBHOOK_URL?: string;
};

export type SourceConfigRecord = SourceConfig;

export type SourceRecordWithPolicy = {
	config: SourceConfigRecord;
	policy: SourcePolicy;
};

export type RuntimeSnapshot = {
	sourceId: string;
	leaseOwner?: string;
	leaseToken?: string;
	leaseExpiresAt?: number;
	cursor?: string;
	nextAllowedAt?: number;
	consecutiveFailures: number;
	lastRunId?: string;
	lastSuccessAt?: string;
	lastErrorAt?: string;
	lastErrorMessage?: string;
	updatedAt: number;
};
