import { test, expect } from "@playwright/test";
import { login } from "./auth-helper";

test.describe("scheduler page", () => {
	test("renders schedule form and table on desktop", async ({ page }) => {
		await login(page, "/scheduler");

		await expect(page.locator("h1")).toContainText("Scheduler Settings");
		await expect(page.locator("#sourceSelect")).toBeVisible();
		await expect(page.locator("#cronInput")).toBeVisible();
		await expect(page.locator("#labelInput")).toBeVisible();
		await expect(page.locator("#enabledToggle")).toBeVisible();
		await expect(page.locator("#addBtn")).toContainText("Add Schedule");
		await expect(page.locator("text=Active Schedules")).toBeVisible();
	});

	test("shows empty state when no schedules", async ({ page }) => {
		await login(page, "/scheduler");
		await expect(page.locator("text=No schedules configured yet.")).toBeVisible();
	});

	test("responsive layout on mobile", async ({ page }) => {
		await login(page, "/scheduler");

		// Form row should stack on small screens
		const formRow = page.locator(".form-row").first();
		await expect(formRow).toBeVisible();
	});
});
