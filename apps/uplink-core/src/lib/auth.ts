import type { Context } from "hono";
import type { Env } from "../types";

export function ensureInternalAuth(c: Context<{ Bindings: Env }>): Response | null {
	if (!c.env.CORE_INTERNAL_KEY) {
		return c.json({ error: "CORE_INTERNAL_KEY not configured" }, 500);
	}

	const header = c.req.header("x-uplink-internal-key");
	if (!header || header !== c.env.CORE_INTERNAL_KEY) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	return null;
}
