import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:email": path.join(__dirname, "src/test/mocks/cloudflare-email.ts"),
		},
	},
	test: {
		name: "uplink-core",
		environment: "node",
		include: [path.join(__dirname, "src/test/**/*.test.ts")],
		exclude: [
			path.join(__dirname, "src/test/integration/**/*.test.ts"),
			path.join(__dirname, "src/test/e2e/**/*.test.ts"),
			path.join(__dirname, "src/test/live/**/*.test.ts"),
			path.join(__dirname, "src/test/unit/durable/**/*.test.ts"),
			path.join(__dirname, "src/test/unit/lib/notifications/providers.test.ts"),
		],
		testTimeout: 10000,
		globals: true,
	},
});
