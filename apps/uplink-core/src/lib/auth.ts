import type { Context } from "hono";
import type { Env } from "../types";

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		// Still do a comparison to avoid leaking length via timing,
		// but against a dummy value of the same length
		const dummy = "\0".repeat(a.length);
		let result = 0;
		for (let i = 0; i < a.length; i++) {
			result |= a.charCodeAt(i) ^ dummy.charCodeAt(i);
		}
		return result === 0;
	}

	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

export function ensureInternalAuth(c: Context<{ Bindings: Env }>): Response | null {
	if (!c.env.CORE_INTERNAL_KEY) {
		return c.json({ error: "CORE_INTERNAL_KEY not configured" }, 500);
	}

	const header = c.req.header("x-uplink-internal-key")?.trim();
	if (!header || !timingSafeEqual(header, c.env.CORE_INTERNAL_KEY)) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	return null;
}

export { timingSafeEqual };
