import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "../../index";

describe("uplink-browser integration", () => {
	const createEnv = () => ({
		BROWSER_API_KEY: "browser-key",
	});

	describe("GET /health", () => {
		it("returns ok", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/health"), env);
			expect(res.status).toBe(200);
			const body = await res.json() as { ok: boolean; service: string };
			expect(body.ok).toBe(true);
			expect(body.service).toBe("uplink-browser");
		});
	});

	describe("POST /internal/collect", () => {
		it("returns 401 without auth", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", { method: "POST" }),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("returns 500 when BROWSER_API_KEY not configured", async () => {
			const env = createEnv();
			(env as unknown as { BROWSER_API_KEY: string | undefined }).BROWSER_API_KEY = undefined;
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key" },
				}),
				env,
			);
			expect(res.status).toBe(500);
		});

		it("returns 400 for invalid body", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({}),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("fetches URL and returns record", async () => {
			const env = createEnv();
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response("<html>Hello</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);

			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);

			expect(res.status).toBe(200);
			const body = await res.json() as { records: Array<{ url: string; status: number }>; hasMore: boolean };
			expect(body.records).toHaveLength(1);
			expect(body.records[0].url).toBe("https://example.com");
			expect(body.records[0].status).toBe(200);
			expect(body.hasMore).toBe(false);
		});

		it("forwards custom headers", async () => {
			const env = createEnv();
			const fetchSpy = vi.fn().mockResolvedValue(
				new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
			);
			globalThis.fetch = fetchSpy;

			await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						url: "https://example.com",
						headers: { "x-custom": "value" },
					}),
				}),
				env,
			);

			expect(fetchSpy).toHaveBeenCalledWith("https://example.com", {
				method: "GET",
				headers: expect.objectContaining({ "x-custom": "value" }),
			});
		});

		it("truncates response body over 250KB", async () => {
			const env = createEnv();
			const hugeBody = "x".repeat(300_000);
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(hugeBody, { status: 200, headers: { "content-type": "text/html" } }),
			);

			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);

			const body = await res.json() as { records: Array<{ body: string }> };
			expect(body.records[0].body.length).toBe(250_000);
		});
	});
});
