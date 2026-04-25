import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8787";

export default defineConfig({
	testDir: "./e2e-playwright",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: "list",
	use: {
		baseURL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},

	projects: [
		// Desktop
		{
			name: "chromium-desktop",
			use: { ...devices["Desktop Chrome"] },
		},
		// Mobile
		{
			name: "chromium-mobile",
			use: { ...devices["Pixel 5"] },
		},
		{
			name: "webkit-mobile",
			use: { ...devices["iPhone 13"] },
		},
	],
});
