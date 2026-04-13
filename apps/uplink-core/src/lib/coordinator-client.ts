import type { Env, RuntimeSnapshot } from "../types";

export type LeaseAcquireResult = {
	acquired: boolean;
	leaseToken?: string;
	reason?: string;
	expiresAt?: number;
};

export function getCoordinatorStub(env: Env, sourceId: string): DurableObjectStub {
	return env.SOURCE_COORDINATOR.getByName(sourceId);
}

export function getBrowserManagerStub(env: Env): DurableObjectStub {
	return env.BROWSER_MANAGER.getByName("global");
}

export async function acquireLease(
	stub: DurableObjectStub,
	params: { requestedBy: string; ttlSeconds: number; force?: boolean; sourceId?: string },
): Promise<LeaseAcquireResult> {
	const sourceId = params.sourceId ?? stub.name ?? stub.id.name;
	const response = await stub.fetch("https://source-coordinator/lease/acquire", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...params, sourceId }),
	});

	if (!response.ok) {
		const reason = await readErrorResponse(response);
		throw new Error(`Failed to acquire source lease: ${reason}`);
	}

	return (await response.json()) as LeaseAcquireResult;
}

export async function releaseLease(stub: DurableObjectStub, leaseToken: string): Promise<boolean> {
	const response = await stub.fetch("https://source-coordinator/lease/release", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ leaseToken }),
	});

	if (!response.ok) {
		const reason = await readErrorResponse(response);
		throw new Error(`Failed to release source lease: ${reason}`);
	}

	const payload = (await response.json()) as { released?: boolean };
	return payload.released === true;
}

export async function advanceCursor(
	stub: DurableObjectStub,
	params: { leaseToken: string; cursor?: string; runId?: string },
): Promise<RuntimeSnapshot> {
	const response = await stub.fetch("https://source-coordinator/cursor/advance", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params),
	});

	if (!response.ok) {
		const reason = await readErrorResponse(response);
		throw new Error(reason);
	}

	return (await response.json()) as RuntimeSnapshot;
}

export async function recordCoordinatorSuccess(
	stub: DurableObjectStub,
	params: { leaseToken: string; runId: string; cursor?: string },
): Promise<RuntimeSnapshot> {
	const response = await stub.fetch("https://source-coordinator/state/success", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params),
	});

	if (!response.ok) {
		throw new Error(`Failed to record coordinator success: ${response.status}`);
	}

	return (await response.json()) as RuntimeSnapshot;
}

export async function recordCoordinatorFailure(
	stub: DurableObjectStub,
	params: { leaseToken: string; runId?: string; errorMessage: string },
): Promise<RuntimeSnapshot> {
	const response = await stub.fetch("https://source-coordinator/state/failure", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params),
	});

	if (!response.ok) {
		throw new Error(`Failed to record coordinator failure: ${response.status}`);
	}

	return (await response.json()) as RuntimeSnapshot;
}

export async function getCoordinatorState(stub: DurableObjectStub): Promise<RuntimeSnapshot> {
	const response = await stub.fetch("https://source-coordinator/state", {
		method: "GET",
	});

	if (!response.ok) {
		throw new Error(`Failed to read coordinator state: ${response.status}`);
	}

	return (await response.json()) as RuntimeSnapshot;
}

async function readErrorResponse(response: Response): Promise<string> {
	const body = await response.text().catch(() => "");
	if (body.length > 0) {
		return body;
	}

	return `${response.status} ${response.statusText}`.trim();
}
