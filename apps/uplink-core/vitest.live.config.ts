import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "live",
		include: ["src/test/live/**/*.test.ts"],
		globals: true,
		environment: "node",
		testTimeout: 30000,
	},
});
