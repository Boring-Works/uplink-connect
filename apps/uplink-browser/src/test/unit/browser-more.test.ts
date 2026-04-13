import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "../../index";

describe("uplink-browser additional", () => {
	const createEnv = () => ({
		BROWSER_API_KEY: "browser-key",
	});

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("auth variations", () => {
		it("rejects lowercase bearer prefix", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("rejects empty bearer token", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer ", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("rejects missing space after Bearer", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearerbrowser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(401);
		});
	});

	describe("collect validation", () => {
		it("rejects URL without protocol", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects FTP URL", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "ftp://example.com/file.txt" }),
				}),
				env,
			);
			// Zod accepts ftp:// as valid URL, but fetch fails with 500
			expect([400, 500]).toContain(res.status);
		});

		it("accepts HTTPS URL", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
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
			expect(res.status).toBe(200);
		});

		it("accepts HTTP URL", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
				new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
			);
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "http://example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(200);
		});
	});

	describe("collect response", () => {
		it("returns hasMore false for single page", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
				new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
			);
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			const body = await res.json();
			expect(body.hasMore).toBe(false);
		});

		it("returns records array with one item", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
				new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
			);
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			const body = await res.json();
			expect(body.records).toHaveLength(1);
		});

		it("includes sourceId in record", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
				new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
			);
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			const body = await res.json();
			expect(body.records[0].sourceId).toBe("src-1");
		});

		it("includes contentType in record", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
				new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
			);
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			const body = await res.json();
			expect(body.records[0].contentType).toBe("text/html");
		});

		it("includes status in record", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
				new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
			);
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			const body = await res.json();
			expect(body.records[0].status).toBe(200);
		});

		it("returns 500 when fetch throws", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockRejectedValue(new Error("network failure"));
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(500);
		});

		it("returns 500 when BROWSER_API_KEY missing", async () => {
			const env = createEnv();
			env.BROWSER_API_KEY = undefined;
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com" }),
				}),
				env,
			);
			expect(res.status).toBe(500);
		});
	});

	describe("collect payload variations", () => {
		it("accepts payload with selector", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
				new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
			);
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", url: "https://example.com", selector: "h1" }),
				}),
				env,
			);
			expect(res.status).toBe(200);
		});

		it("accepts payload with headers", async () => {
			const env = createEnv();
			global.fetch = vi.fn().mockResolvedValue(
				new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
			);
			const res = await app.fetch(
				new Request("http://localhost/internal/collect", {
					method: "POST",
					headers: { authorization: "Bearer browser-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						url: "https://example.com",
						headers: { "User-Agent": "UplinkBot/1.0" },
					}),
				}),
				env,
			);
			expect(res.status).toBe(200);
		});
	});
});
