import { test, expect } from "@playwright/test";
import { login } from "./auth-helper";

test.describe("dashboard page", () => {
	test("renders key elements on desktop", async ({ page }) => {
		await login(page, "/dashboard");

		await expect(page.locator("h1")).toContainText("Uplink Connect");
		await expect(page.locator("text=System Dashboard")).toBeVisible();
		await expect(page.locator("text=Total Sources")).toBeVisible();
		await expect(page.locator("text=Runs (24h)")).toBeVisible();
		await expect(page.locator("text=Queue Lag")).toBeVisible();
		await expect(page.locator("text=Active Alerts")).toBeVisible();
		await expect(page.locator("text=Pending Errors")).toBeVisible();
		await expect(page.locator("text=Entities")).toBeVisible();
		await expect(page.locator("text=Data Pipeline Flow")).toBeVisible();
		await expect(page.locator("text=Component Health")).toBeVisible();
		await expect(page.locator("text=Recent Runs")).toBeVisible();
		await expect(page.locator("text=Recent Errors")).toBeVisible();
	});

	test("navigation links work", async ({ page }) => {
		await login(page, "/dashboard");

		await page.locator('a[href="/scheduler"]').click();
		await expect(page).toHaveURL(/\/scheduler/);
		await expect(page.locator("h1")).toContainText("Scheduler");

		await page.locator('a[href="/settings"]').click();
		await expect(page).toHaveURL(/\/settings/);
		await expect(page.locator("h1")).toContainText("Settings");

		await page.locator('a[href="/audit-log"]').click();
		await expect(page).toHaveURL(/\/audit-log/);
		await expect(page.locator("h1")).toContainText("Audit Log");
	});

	test("shows password gate when unauthenticated", async ({ page, context }) => {
		// Clear any existing state
		await context.clearCookies();
		await page.goto("/dashboard");
		await expect(page.locator('input[type="password"]')).toBeVisible();
		await expect(page.locator("text=Unlock")).toBeVisible();
	});
});
