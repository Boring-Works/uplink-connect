import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

const testsDir = import.meta.dirname;

export default defineWorkersConfig({
	test: {
		name: "integration",
		include: [path.join(testsDir, "**/*.test.ts")],
		setupFiles: [path.join(testsDir, "setup.ts")],
		testTimeout: 30000,
		globals: true,
		poolOptions: {
			workers: {
				isolatedStorage: false,
				singleWorker: true,
				wrangler: {
					configPath: path.join(testsDir, "wrangler.jsonc"),
				},
			},
		},
	},
});
