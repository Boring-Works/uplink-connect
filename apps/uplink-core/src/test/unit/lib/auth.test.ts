import { describe, expect, it, vi } from "vitest";
import { ensureInternalAuth } from "../../../lib/auth";

function createMockContext(headerValue: string | null, key: string | undefined) {
	return {
		req: {
			header: vi.fn().mockReturnValue(headerValue),
		},
		env: { CORE_INTERNAL_KEY: key },
		json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }),
	} as unknown as Parameters<typeof ensureInternalAuth>[0];
}

describe("ensureInternalAuth", () => {
	it("returns null when key matches", () => {
		const c = createMockContext("valid-key", "valid-key");
		const result = ensureInternalAuth(c);
		expect(result).toBeNull();
	});

	it("returns 401 when header is missing", () => {
		const c = createMockContext(null, "valid-key");
		const result = ensureInternalAuth(c);
		expect(result).not.toBeNull();
		expect((result as Response).status).toBe(401);
	});

	it("returns 401 when key does not match", () => {
		const c = createMockContext("wrong-key", "valid-key");
		const result = ensureInternalAuth(c);
		expect(result).not.toBeNull();
		expect((result as Response).status).toBe(401);
	});

	it("returns 500 when internal key not configured", () => {
		const c = createMockContext("any-key", undefined);
		const result = ensureInternalAuth(c);
		expect(result).not.toBeNull();
		expect((result as Response).status).toBe(500);
	});

	it("trims whitespace from header", () => {
		const c = createMockContext("  valid-key  ", "valid-key");
		const result = ensureInternalAuth(c);
		expect(result).toBeNull();
	});

	it("returns 401 when header is empty string", () => {
		const c = createMockContext("", "valid-key");
		const result = ensureInternalAuth(c);
		expect(result).not.toBeNull();
		expect((result as Response).status).toBe(401);
	});

	it("returns 401 when header is only whitespace", () => {
		const c = createMockContext("   ", "valid-key");
		const result = ensureInternalAuth(c);
		expect(result).not.toBeNull();
		expect((result as Response).status).toBe(401);
	});

	it("returns error message in response body", async () => {
		const c = createMockContext(null, "valid-key");
		const result = ensureInternalAuth(c);
		const body = await (result as Response).json();
		expect(body.error).toBeDefined();
	});
});
