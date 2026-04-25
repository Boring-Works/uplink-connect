import type { Page } from "@playwright/test";

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "test-dashboard-pass";

/**
 * Log in to the dashboard via the password gate.
 * Returns the page navigated to the dashboard.
 */
export async function login(page: Page, path = "/dashboard"): Promise<Page> {
	await page.goto(path);

	// If we're already past the gate, just return
	if (await page.locator('input[type="password"]').isVisible().catch(() => false)) {
		await page.locator('input[type="password"]').fill(DASHBOARD_PASSWORD);
		await page.locator('button[type="submit"]').click();
		await page.waitForURL(path);
	}

	return page;
}
