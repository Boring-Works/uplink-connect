import type { Env } from "../types";
import { timingSafeEqual } from "./auth";

const PASSWORD_COOKIE_NAME = "uplink_dashboard_auth";

/**
 * Generate a simple hash from password for storage comparison.
 * NOTE: This is not bcrypt-level security, but sufficient for a dashboard gate
 * in a Cloudflare Workers environment where bcrypt is impractical.
 */
export async function hashPassword(password: string): Promise<string> {
	const encoder = new TextEncoder();
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(password));
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Get the configured dashboard password hash from settings or env.
 * If neither is set, generates and returns a default password hash.
 */
export async function getDashboardPasswordHash(env: Env): Promise<{ hash: string; isDefault: boolean; defaultPassword?: string }> {
	// First check env var override
	if (env.DASHBOARD_PASSWORD) {
		const hash = await hashPassword(env.DASHBOARD_PASSWORD);
		return { hash, isDefault: false };
	}

	// Then check platform settings
	try {
		const stored = await env.CONTROL_DB.prepare(
			`SELECT settings_json FROM platform_settings WHERE settings_key = ?`,
		)
			.bind("platform_settings_v1")
			.first<{ settings_json: string }>();

		if (stored?.settings_json) {
			const parsed = JSON.parse(stored.settings_json);
			if (parsed.security?.dashboardPasswordHash) {
				return { hash: parsed.security.dashboardPasswordHash, isDefault: false };
			}
		}
	} catch {
		// fall through
	}

	// Use fixed default password
	const defaultPassword = "wecreate";
	const hash = await hashPassword(defaultPassword);
	return { hash, isDefault: true, defaultPassword };
}

/**
 * Check if the current request is authenticated for dashboard access.
 * Returns null if authenticated, or a password gate HTML response if not.
 */
export async function ensureDashboardAuth(
	request: Request,
	env: Env,
	options: { pageTitle: string; returnPath: string },
): Promise<Response | null> {
	const { hash, isDefault, defaultPassword } = await getDashboardPasswordHash(env);

	const cookieHeader = request.headers.get("cookie") ?? "";
	const cookies = parseCookies(cookieHeader);
	const authCookie = cookies[PASSWORD_COOKIE_NAME];

	if (authCookie) {
		const cookieHash = await hashPassword(authCookie);
		if (timingSafeEqual(cookieHash, hash)) {
			return null;
		}
	}

	// Check for form submission
	const url = new URL(request.url);
	const submittedPassword = url.searchParams.get("password") ?? "";
	if (submittedPassword) {
		const submittedHash = await hashPassword(submittedPassword);
		if (timingSafeEqual(submittedHash, hash)) {
			// Set cookie and redirect
			const headers = new Headers();
			headers.set(
				"Set-Cookie",
				`${PASSWORD_COOKIE_NAME}=${submittedPassword}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`,
			);
			headers.set("Location", options.returnPath);
			return new Response(null, { status: 302, headers });
		}
	}

	// Return password gate HTML
	const defaultHint = isDefault
		? `<div style="margin-top: 16px; padding: 12px; background: rgba(200,122,66,0.1); border-radius: 8px; color: var(--graphite); font-size: 0.9rem;">
			<strong>Default password:</strong> <code style="background: var(--sawdust); padding: 2px 6px; border-radius: 4px; font-family: 'IBM Plex Mono', monospace;">${defaultPassword}</code>
			<div style="margin-top: 6px; font-size: 0.8rem;">Change this in Settings after logging in.</div>
		</div>`
		: "";

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(options.pageTitle)}</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=Source+Sans+3:ital,wght@0,200..900;1,200..900&display=swap" rel="stylesheet">
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		:root {
			--carbon: #1C1C1C;
			--graphite: #3D3D3D;
			--forge: #C87A42;
			--forge-hover: #A86435;
			--white: #FAFAF8;
			--workbench: #F0EEEA;
			--sawdust: #E8E5DF;
			--grain: #D5D0C9;
		}
		body {
			font-family: 'Source Sans 3', system-ui, sans-serif;
			background: var(--white);
			color: var(--carbon);
			display: flex;
			align-items: center;
			justify-content: center;
			min-height: 100vh;
			padding: 24px;
		}
		.gate {
			background: var(--workbench);
			border: 1px solid var(--grain);
			border-radius: 14px;
			padding: 36px;
			max-width: 400px;
			width: 100%;
		}
		.gate h1 {
			font-family: 'DM Sans', system-ui, sans-serif;
			font-size: 1.5rem;
			margin-bottom: 8px;
		}
		.gate p {
			color: var(--graphite);
			margin-bottom: 20px;
		}
		input[type="password"] {
			width: 100%;
			padding: 12px 14px;
			border: 1px solid var(--grain);
			border-radius: 10px;
			background: var(--white);
			font-size: 1rem;
			margin-bottom: 12px;
		}
		input[type="password"]:focus {
			outline: none;
			border-color: var(--forge);
			box-shadow: 0 0 0 3px rgba(200,122,66,0.12);
		}
		button {
			width: 100%;
			padding: 12px;
			border: none;
			border-radius: 10px;
			background: var(--forge);
			color: var(--white);
			font-size: 1rem;
			font-weight: 600;
			cursor: pointer;
		}
		button:hover { background: var(--forge-hover); }
		.error {
			color: #9B2C2C;
			font-size: 0.9rem;
			margin-bottom: 12px;
		}
	</style>
</head>
<body>
	<div class="gate">
		<h1>${escapeHtml(options.pageTitle)}</h1>
		<p>Enter the dashboard password to continue.</p>
		${submittedPassword ? '<div class="error">Incorrect password. Please try again.</div>' : ''}
		<form method="GET" action="${escapeHtml(options.returnPath)}">
			<input type="password" name="password" placeholder="Password" autofocus required>
			<button type="submit">Unlock</button>
		</form>
		${defaultHint}
	</div>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

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

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
