import type { Context } from "hono";
import { timingSafeEqual } from "@uplink/contracts";
import type { Env } from "../types";
import { getDashboardPasswordHash, hashPassword } from "./dashboard-auth";

const PASSWORD_COOKIE_NAME = "uplink_dashboard_auth";

function parseCookies(cookieHeader: string): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const cookie of cookieHeader.split(";")) {
		const [name, ...rest] = cookie.trim().split("=");
		if (name && rest.length > 0) {
			cookies[name] = rest.join("=");
		}
	}
	return cookies;
}

async function verifyDashboardToken(token: string, passwordHash: string): Promise<boolean> {
	const parts = token.split(":");
	if (parts.length !== 2) return false;
	const timestamp = Number.parseInt(parts[0], 10);
	if (!Number.isFinite(timestamp)) return false;
	if (Date.now() - timestamp > 24 * 60 * 60 * 1000) return false;

	const encoder = new TextEncoder();
	const data = encoder.encode(`${passwordHash}:${timestamp}`);
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(passwordHash.slice(0, 32)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, data);
	const sigHex = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const expected = `${timestamp}:${sigHex}`;
	return timingSafeEqual(token, expected);
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

/**
 * Checks either internal key auth OR valid dashboard cookie.
 * Use this for endpoints that need to be accessible from the dashboard UI.
 */
export async function ensureInternalOrDashboardAuth(c: Context<{ Bindings: Env }>): Promise<Response | null> {
	// First check internal key (fast path)
	if (c.env.CORE_INTERNAL_KEY) {
		const header = c.req.header("x-uplink-internal-key")?.trim();
		if (header && timingSafeEqual(header, c.env.CORE_INTERNAL_KEY)) {
			return null;
		}
	}

	// Then check dashboard cookie
	const passwordConfig = await getDashboardPasswordHash(c.env);
	if (passwordConfig) {
		const cookieHeader = c.req.header("cookie") ?? "";
		const cookies = parseCookies(cookieHeader);
		const authCookie = cookies[PASSWORD_COOKIE_NAME];
		if (authCookie && await verifyDashboardToken(authCookie, passwordConfig.hash)) {
			return null;
		}
	}

	return c.json({ error: "Unauthorized" }, 401);
}

export { timingSafeEqual };
