import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		name: "unit",
		environment: "node",
		include: [path.join(__dirname, "src/test/unit/**/*.test.ts")],
		exclude: [path.join(__dirname, "src/test/unit/durable/**/*.test.ts")],
		testTimeout: 10000,
		globals: true,
	},
});
