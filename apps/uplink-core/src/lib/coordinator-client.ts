import type { Env, RuntimeSnapshot } from "../types";
import type { SourceCoordinator } from "../durable/source-coordinator";
import type { BrowserManagerDO } from "../durable/browser-manager";

export type LeaseAcquireResult = {
	acquired: boolean;
	leaseToken?: string;
	reason?: string;
	expiresAt?: number;
};

/** Typed stub for SourceCoordinator RPC calls */
export type CoordinatorStub = DurableObjectStub<SourceCoordinator>;

/** Typed stub for BrowserManagerDO RPC calls */
export type BrowserManagerStub = DurableObjectStub<BrowserManagerDO>;

export function getCoordinatorStub(env: Env, sourceId: string): CoordinatorStub {
	return env.SOURCE_COORDINATOR.getByName(sourceId);
}

export function getBrowserManagerStub(env: Env): BrowserManagerStub {
	return env.BROWSER_MANAGER.getByName("global");
}

// === BrowserManagerDO RPC wrappers ===

export async function requestBrowserSession(
	stub: BrowserManagerStub,
	params: { sourceId: string; requestId: string; priority?: number },
): Promise<{ sessionId: string; assigned: boolean; queuePosition?: number; estimatedWaitMs?: number; reason?: string }> {
	return stub.requestSessionRpc(params);
}

export async function releaseBrowserSession(
	stub: BrowserManagerStub,
	params: { sessionId: string; sourceId: string; error?: boolean },
): Promise<{ released: boolean; reason?: string }> {
	return stub.releaseSessionRpc(params);
}

export async function heartbeatBrowserSession(
	stub: BrowserManagerStub,
	params: { sessionId: string; sourceId: string },
): Promise<{ ok: boolean }> {
	return stub.heartbeatRpc(params);
}

export async function getBrowserManagerStatus(stub: BrowserManagerStub): Promise<object> {
	return stub.getStatusRpc();
}

export async function forceBrowserManagerCleanup(stub: BrowserManagerStub): Promise<object> {
	return stub.forceCleanupRpc();
}

export async function acquireLease(
	stub: CoordinatorStub,
	params: { requestedBy: string; ttlSeconds: number; force?: boolean; sourceId?: string },
): Promise<LeaseAcquireResult> {
	const sourceId = params.sourceId ?? stub.id.name ?? "unknown";
	return stub.acquireLease({ ...params, sourceId });
}

export async function releaseLease(stub: CoordinatorStub, leaseToken: string): Promise<boolean> {
	const result = await stub.releaseLease({ leaseToken });
	return result.released;
}

export async function advanceCursor(
	stub: CoordinatorStub,
	params: { leaseToken: string; cursor?: string; runId?: string },
): Promise<RuntimeSnapshot> {
	return stub.advanceCursor(params);
}

export async function recordCoordinatorSuccess(
	stub: CoordinatorStub,
	params: { leaseToken: string; runId: string; cursor?: string },
): Promise<RuntimeSnapshot> {
	return stub.recordSuccess(params);
}

export async function recordCoordinatorFailure(
	stub: CoordinatorStub,
	params: { leaseToken: string; runId?: string; errorMessage: string },
): Promise<RuntimeSnapshot> {
	return stub.recordFailure(params);
}

export async function unpauseCoordinator(stub: CoordinatorStub): Promise<{ unpaused: boolean; reason?: string }> {
	return stub.unpause();
}

export async function getCoordinatorState(stub: CoordinatorStub): Promise<RuntimeSnapshot> {
	return stub.getState();
}
