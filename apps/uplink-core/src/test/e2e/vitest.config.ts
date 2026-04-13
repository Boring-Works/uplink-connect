import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

const testsDir = import.meta.dirname;

export default defineWorkersConfig({
	test: {
		name: "e2e",
		include: [path.join(testsDir, "**/*.test.ts")],
		setupFiles: [path.join(testsDir, "../integration/setup.ts")],
		testTimeout: 30000,
		globals: true,
		poolOptions: {
			workers: {
				isolatedStorage: false,
				singleWorker: true,
				wrangler: {
					configPath: path.join(testsDir, "../integration/wrangler.jsonc"),
				},
			},
		},
	},
});
