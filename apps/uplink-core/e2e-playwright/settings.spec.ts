import { test, expect } from "@playwright/test";
import { login } from "./auth-helper";

test.describe("settings page", () => {
	test("renders settings form on desktop", async ({ page }) => {
		await login(page, "/settings");

		await expect(page.locator("h1")).toContainText("Platform Settings");
		await expect(page.locator("#settingsInput")).toBeVisible();
		await expect(page.locator("#saveBtn")).toContainText("Save Changes");
	});

	test("shows toast on successful save", async ({ page }) => {
		await login(page, "/settings");

		// Clear the textarea and enter valid JSON
		await page.locator("#settingsInput").fill(JSON.stringify({ platform: { maintenanceMode: true } }, null, 2));
		await page.locator("#saveBtn").click();

		await expect(page.locator(".toast.success")).toContainText("Settings saved");
	});

	test("shows error toast on invalid JSON", async ({ page }) => {
		await login(page, "/settings");

		await page.locator("#settingsInput").fill("not valid json");
		await page.locator("#saveBtn").click();

		await expect(page.locator(".toast.error")).toContainText("Invalid JSON");
	});
});
