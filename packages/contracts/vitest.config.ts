import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		name: "contracts",
		environment: "node",
		include: [path.join(__dirname, "src/test/**/*.test.ts")],
		testTimeout: 10000,
		globals: true,
	},
});
