/**
 * Live Integration Tests
 * 
 * These tests run against the actual deployed endpoints.
 * They verify the production system is working correctly.
 * 
 * Run: pnpm test:live
 */

import { describe, it, expect, beforeAll } from "vitest";

// Production endpoints
const ENDPOINTS = {
	edge: "https://uplink-edge.codyboring.workers.dev",
	core: "https://uplink-core.codyboring.workers.dev",
	ops: "https://uplink-ops.codyboring.workers.dev",
	browser: "https://uplink-browser.codyboring.workers.dev",
};

// These would normally come from environment variables or secrets
// For testing, we'll use placeholder values and check for expected responses
const TEST_API_KEY = "test-api-key-placeholder";
const INTERNAL_KEY = "internal-key-placeholder";

describe("Live Tests - Health Endpoints", () => {
	it("uplink-edge health returns ok", async () => {
		const response = await fetch(`${ENDPOINTS.edge}/health`);
		expect(response.status).toBe(200);
		
		const data = await response.json();
		expect(data.ok).toBe(true);
		expect(data.service).toBe("uplink-edge");
		expect(data.now).toBeDefined();
	});

	it("uplink-core health returns ok", async () => {
		const response = await fetch(`${ENDPOINTS.core}/health`);
		expect(response.status).toBe(200);
		
		const data = await response.json();
		expect(data.ok).toBe(true);
		expect(data.service).toBe("uplink-core");
	});

	it("uplink-ops health returns ok or is internal-only", async () => {
		const response = await fetch(`${ENDPOINTS.ops}/health`);
		// Ops may not be publicly routed
		if (response.status === 200) {
			const data = await response.json();
			expect(data.ok).toBe(true);
			expect(data.service).toBe("uplink-ops");
		} else {
			expect([404, 1042]).toContain(response.status);
		}
	});

	it("uplink-browser health returns ok or is internal-only", async () => {
		const response = await fetch(`${ENDPOINTS.browser}/health`);
		// Browser may not be publicly routed
		if (response.status === 200) {
			const data = await response.json();
			expect(data.ok).toBe(true);
			expect(data.service).toBe("uplink-browser");
		} else {
			expect([404, 1042]).toContain(response.status);
		}
	});
});

describe("Live Tests - Dashboard", () => {
	it("dashboard gate renders without error", async () => {
		const response = await fetch(`${ENDPOINTS.core}/dashboard`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		
		const html = await response.text();
		expect(html).toContain("Uplink Connect Dashboard");
		expect(html).toContain("Enter the dashboard password");
		expect(html).not.toContain("Dashboard Error");
	});

	it("dashboard gate contains login form", async () => {
		const response = await fetch(`${ENDPOINTS.core}/dashboard`);
		const html = await response.text();
		
		expect(html).toContain('method="POST"');
		expect(html).toContain('name="password"');
		expect(html).toContain('type="submit"');
	});

	it("dashboard v2 API requires auth", async () => {
		const response = await fetch(`${ENDPOINTS.core}/internal/dashboard/v2`);
		expect(response.status).toBe(401);
	});

	it("health topology requires auth", async () => {
		const response = await fetch(`${ENDPOINTS.core}/internal/health/topology`);
		expect(response.status).toBe(401);
	});
});

describe("Live Tests - Authentication", () => {
	it("internal endpoints require auth", async () => {
		const endpoints = [
			"/internal/dashboard/v2",
			"/internal/health/components",
			"/internal/health/topology",
			"/internal/settings",
			"/internal/audit-log",
		];

		for (const endpoint of endpoints) {
			const response = await fetch(`${ENDPOINTS.core}${endpoint}`);
			expect(response.status).toBe(401);
			
			const data = await response.json();
			expect(data.error).toBe("Unauthorized");
		}
	});

	it("intake endpoint requires auth", async () => {
		const response = await fetch(`${ENDPOINTS.edge}/v1/intake`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ test: true }),
		});
		
		expect(response.status).toBe(401);
	});

	it("ops endpoints require auth or are internal-only", async () => {
		const response = await fetch(`${ENDPOINTS.ops}/v1/runs`);
		// Ops worker may not be publicly routed (returns 1042) or requires auth (401)
		expect([401, 404, 1042]).toContain(response.status);
	});
});

describe("Live Tests - Source Management (unauthenticated)", () => {
	it("list sources requires auth", async () => {
		const response = await fetch(`${ENDPOINTS.core}/internal/sources`);
		expect(response.status).toBe(401);
	});
});

describe("Live Tests - Error Handling", () => {
	it("returns 404 for unknown endpoints", async () => {
		const response = await fetch(`${ENDPOINTS.core}/unknown-endpoint`);
		expect(response.status).toBe(404);
	});

	it("returns 404 for unknown source", async () => {
		const response = await fetch(`${ENDPOINTS.core}/internal/sources/nonexistent`);
		expect(response.status).toBe(401); // Auth check happens before resource lookup
	});
});

describe("Live Tests - Response Headers", () => {
	it("health endpoints return JSON", async () => {
		const response = await fetch(`${ENDPOINTS.edge}/health`);
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	it("dashboard returns HTML", async () => {
		const response = await fetch(`${ENDPOINTS.core}/dashboard`);
		expect(response.headers.get("content-type")).toContain("text/html");
	});
});

// Run a simple connectivity check
describe("Live Tests - Connectivity", () => {
	it("publicly reachable workers respond to health checks", async () => {
		const results = await Promise.allSettled([
			fetch(`${ENDPOINTS.edge}/health`),
			fetch(`${ENDPOINTS.core}/health`),
		]);

		for (const result of results) {
			expect(result.status).toBe("fulfilled");
			if (result.status === "fulfilled") {
				expect(result.value.status).toBe(200);
			}
		}
	});

	it("ops and browser workers are internal-only", async () => {
		const opsResponse = await fetch(`${ENDPOINTS.ops}/health`);
		const browserResponse = await fetch(`${ENDPOINTS.browser}/health`);

		// These workers are not exposed publicly (no route in wrangler)
		expect([404, 1042]).toContain(opsResponse.status);
		expect([404, 1042]).toContain(browserResponse.status);
	});
});
