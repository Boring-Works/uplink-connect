import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "../../index";

describe("uplink-browser unit", () => {
	const createEnv = () => ({
		BROWSER_API_KEY: "browser-key",
	});

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("health", () => {
		it("returns service name", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/health"), env);
			const body = await res.json() as { service: string };
			expect(body.service).toBe("uplink-browser");
		});

		it("returns current timestamp", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/health"), env);
			const body = await res.json() as { now: string };
			expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("collect validation", () => {
		it("rejects missing sourceId", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ url: "https://example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects invalid URL", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "not-a-url" }),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects empty sourceId", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "", url: "https://example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});
	});

	describe("collect behavior", () => {
		it("uses custom user-agent", async () => {
			const env = createEnv();
			const fetchSpy = vi.fn().mockResolvedValue(
				new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
			);
			globalThis.fetch = fetchSpy;

			await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://example.com",
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						"user-agent": "Mozilla/5.0 (compatible; UplinkConnect/3.01; +https://uplink.internal)",
					}),
				}),
			);
		});

		it("includes accept header", async () => {
			const env = createEnv();
			const fetchSpy = vi.fn().mockResolvedValue(
				new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
			);
			globalThis.fetch = fetchSpy;

			await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://example.com",
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						accept: "text/html,application/json;q=0.9,*/*;q=0.8",
					}),
				}),
			);
		});

		it("returns contentType in response", async () => {
			const env = createEnv();
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response("html", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
			);

			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);

			const body = await res.json() as { records: Array<{ contentType: string }> };
			expect(body.records[0].contentType).toBe("text/html; charset=utf-8");
		});

		it("returns fetchedAt timestamp", async () => {
			const env = createEnv();
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
			);

			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);

			const body = await res.json() as { records: Array<{ fetchedAt: string }> };
			expect(body.records[0].fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});
});
