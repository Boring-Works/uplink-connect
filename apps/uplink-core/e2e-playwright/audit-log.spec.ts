import { test, expect } from "@playwright/test";
import { login } from "./auth-helper";

test.describe("audit log page", () => {
	test("renders audit log entries on desktop", async ({ page }) => {
		await login(page, "/audit-log");

		await expect(page.locator("h1")).toContainText("Audit Log");
		await expect(page.locator(".log-item").first()).toBeVisible();
	});

	test("pagination controls are present", async ({ page }) => {
		await login(page, "/audit-log");

		// Check that pagination info is shown
		await expect(page.locator("text=Showing")).toBeVisible();
	});

	test("responsive layout on mobile", async ({ page }) => {
		await login(page, "/audit-log");

		// Log items should be visible on mobile too
		await expect(page.locator(".log-item").first()).toBeVisible();
	});
});
