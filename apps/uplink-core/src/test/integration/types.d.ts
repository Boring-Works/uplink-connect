/**
 * Type declarations for integration tests
 */

declare module "cloudflare:test" {
	import type { Env } from "../../types";

	interface ProvidedEnv extends Env {}
}
