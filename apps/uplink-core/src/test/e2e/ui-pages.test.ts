import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import type { Env as CoreEnv } from "../../types";

// UI/UX e2e tests verify HTML pages render correctly, auth flows work,
// and frontend elements are wired to backend endpoints.

describe("ui pages", () => {
	let coreEnv: CoreEnv;
	let authCookie: string;

	beforeAll(async () => {
		coreEnv = env as unknown as CoreEnv;
		// Authenticate via password form to get dashboard cookie
		const loginRes = await SELF.fetch("http://localhost/dashboard", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ password: "test-dashboard-pass" }).toString(),
			redirect: "manual",
		});
		expect(loginRes.status).toBe(302);
		const setCookie = loginRes.headers.get("set-cookie") ?? "";
		const match = setCookie.match(/uplink_dashboard_auth=([^;]+)/);
		authCookie = match ? `uplink_dashboard_auth=${match[1]}` : "";
		expect(authCookie).toBeTruthy();
	});

	describe("dashboard page", () => {
		it("returns the HTML dashboard with key elements", async () => {
			const res = await SELF.fetch("http://localhost/dashboard", {
				headers: { cookie: authCookie },
			});
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Uplink Connect");
			expect(html).toContain("System Dashboard");
			expect(html).toContain('href="/scheduler"');
			expect(html).toContain('href="/settings"');
			expect(html).toContain('href="/audit-log"');
			expect(html).toContain('data-metric="sources"');
			expect(html).toContain('data-metric="runs"');
			expect(html).toContain('data-metric="queue"');
			expect(html).toContain('data-metric="alerts"');
			expect(html).toContain('data-metric="errors"');
			expect(html).toContain('data-metric="entities"');
			expect(html).toContain("Data Pipeline Flow");
			expect(html).toContain("Component Health");
			expect(html).toContain("Active Alerts");
			expect(html).toContain("Recent Runs");
			expect(html).toContain("Recent Errors");
			expect(html).toContain("window.triggerSource");
			expect(html).toContain("window.replayRun");
			expect(html).toContain("window.retryError");
			expect(html).toContain("window.ackAlert");
			expect(html).toContain("window.resolveAlert");
			// Should NOT have aggressive meta refresh
			expect(html).not.toContain('http-equiv="refresh"');
			// Should have WebSocket connection script
			expect(html).toContain("WebSocket(");
		});

		it("requires auth without cookie", async () => {
			const res = await SELF.fetch("http://localhost/dashboard");
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Enter the dashboard password");
		});
	});

	describe("scheduler page", () => {
		it("returns the HTML scheduler with key elements", async () => {
			const res = await SELF.fetch("http://localhost/scheduler", {
				headers: { cookie: authCookie },
			});
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Scheduler Settings");
			expect(html).toContain('id="sourceSelect"');
			expect(html).toContain('id="cronInput"');
			expect(html).toContain('id="labelInput"');
			expect(html).toContain('id="enabledToggle"');
			expect(html).toContain('id="addBtn"');
			expect(html).toContain('id="schedulesTableWrap"');
			expect(html).toContain("Add Schedule");
			expect(html).toContain("Active Schedules");
			expect(html).toContain("bulkEnable(");
			expect(html).toContain("bulkDelete(");
		});

		it("lists and manages schedules through the API", async () => {
			// Create a source first
			const sourceId = `ui-src-${Date.now()}`;
			await SELF.fetch("http://localhost/internal/sources", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-uplink-internal-key": coreEnv.CORE_INTERNAL_KEY,
				},
				body: JSON.stringify({
					sourceId,
					name: "UI Test Source",
					type: "api",
					adapterType: "api",
					policy: {
						leaseTtlSeconds: 60,
						minIntervalSeconds: 1,
						maxRecordsPerRun: 100,
						retryLimit: 3,
						timeoutSeconds: 60,
					},
				}),
			});

			// Create a schedule
			const createRes = await SELF.fetch("http://localhost/internal/schedules", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-uplink-internal-key": coreEnv.CORE_INTERNAL_KEY,
				},
				body: JSON.stringify({
					sourceId,
					cronExpression: "0 * * * *",
					label: "Hourly",
					enabled: true,
				}),
			});
			expect(createRes.status).toBe(201);
			const { schedule } = await createRes.json();
			expect(schedule).toHaveProperty("scheduleId");

			// List schedules
			const listRes = await SELF.fetch("http://localhost/internal/schedules", {
				headers: { "x-uplink-internal-key": coreEnv.CORE_INTERNAL_KEY },
			});
			expect(listRes.status).toBe(200);
			const listBody = await listRes.json();
			expect(listBody.schedules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ scheduleId: schedule.scheduleId }),
				]),
			);

			// Update schedule
			const updateRes = await SELF.fetch(
				`http://localhost/internal/schedules/${schedule.scheduleId}`,
				{
					method: "PUT",
					headers: {
						"content-type": "application/json",
						"x-uplink-internal-key": coreEnv.CORE_INTERNAL_KEY,
					},
					body: JSON.stringify({ enabled: false }),
				},
			);
			expect(updateRes.status).toBe(200);
			const updated = await updateRes.json();
			expect(updated.schedule.enabled).toBe(false);

			// Delete schedule
			const deleteRes = await SELF.fetch(
				`http://localhost/internal/schedules/${schedule.scheduleId}`,
				{
					method: "DELETE",
					headers: { "x-uplink-internal-key": coreEnv.CORE_INTERNAL_KEY },
				},
			);
			expect(deleteRes.status).toBe(200);
		});
	});

	describe("settings page", () => {
		it("returns the HTML settings page with key elements", async () => {
			const res = await SELF.fetch("http://localhost/settings", {
				headers: { cookie: authCookie },
			});
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Platform Settings");
			expect(html).toContain('id="settingsInput"');
			expect(html).toContain('id="saveBtn"');
			expect(html).toContain("Save Changes");
		});

		it("saves settings via POST and reflects changes", async () => {
			const saveRes = await SELF.fetch("http://localhost/settings", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: authCookie,
				},
				body: JSON.stringify({ platform: { maintenanceMode: true } }),
			});
			expect(saveRes.status).toBe(200);
			const body = await saveRes.json();
			expect(body).toHaveProperty("platform");
			expect(body.platform).toHaveProperty("maintenanceMode", true);

			// Verify via internal API
			const getRes = await SELF.fetch("http://localhost/internal/settings", {
				headers: { "x-uplink-internal-key": coreEnv.CORE_INTERNAL_KEY },
			});
			expect(getRes.status).toBe(200);
			const settings = await getRes.json();
			expect(settings).toHaveProperty("platform");
			expect(settings.platform).toHaveProperty("maintenanceMode", true);
		});
	});

	describe("audit log page", () => {
		it("returns the HTML audit log with pagination", async () => {
			const res = await SELF.fetch("http://localhost/audit-log", {
				headers: { cookie: authCookie },
			});
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Audit Log");
			expect(html).toContain('class="log-item"');
			// Should contain the settings update from previous test
			expect(html).toContain("settings.update");
		});

		it("supports pagination via query params", async () => {
			const res = await SELF.fetch("http://localhost/audit-log?limit=1&offset=0", {
				headers: { cookie: authCookie },
			});
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Showing 1-1");
		});
	});

	describe("auth flow", () => {
		it("shows password gate when not authenticated", async () => {
			const res = await SELF.fetch("http://localhost/dashboard");
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Enter the dashboard password");
			expect(html).toContain('type="password"');
			expect(html).toContain("Unlock");
		});

		it("rejects wrong password and shows error", async () => {
			const res = await SELF.fetch("http://localhost/dashboard", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ password: "wrong-password" }).toString(),
				redirect: "manual",
			});
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Incorrect password");
		});

		it("accepts correct password and sets cookie", async () => {
			const res = await SELF.fetch("http://localhost/dashboard", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ password: "test-dashboard-pass" }).toString(),
				redirect: "manual",
			});
			expect(res.status).toBe(302);
			const setCookie = res.headers.get("set-cookie") ?? "";
			expect(setCookie).toContain("uplink_dashboard_auth=");
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("SameSite=Lax");
		});

		it("carries auth across pages with cookie", async () => {
			const pages = ["/dashboard", "/scheduler", "/settings", "/audit-log"];
			for (const path of pages) {
				const res = await SELF.fetch(`http://localhost${path}`, {
					headers: { cookie: authCookie },
				});
				expect(res.status).toBe(200);
				const html = await res.text();
				expect(html).not.toContain("Enter the dashboard password");
			}
		});
	});
});
