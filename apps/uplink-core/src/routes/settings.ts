import { Hono } from "hono";
import type { Env } from "../types";
import { getSettings, saveSettings, logAuditEvent, getAuditLog } from "../lib/settings";
import { ensureDashboardAuth } from "../lib/dashboard-auth";

const app = new Hono<{ Bindings: Env }>();

// JSON API: Get settings
app.get("/internal/settings", async (c) => {
	const settings = await getSettings(c.env);
	return c.json(settings);
});

// JSON API: Update settings
app.put("/internal/settings", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const actor = c.req.header("x-actor-id") ?? "system";

	const updated = await saveSettings(c.env, body, actor);

	await logAuditEvent(c.env.CONTROL_DB, {
		action: "settings.update",
		actor,
		resourceType: "settings",
		details: { changedFields: Object.keys(body) },
	});

	return c.json(updated);
});

// JSON API: Get audit log
app.get("/internal/audit-log", async (c) => {
	const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
	const resourceType = c.req.query("resourceType") ?? undefined;
	const actor = c.req.query("actor") ?? undefined;
	const fromDate = c.req.query("fromDate") ?? undefined;
	const toDate = c.req.query("toDate") ?? undefined;

	const result = await getAuditLog(c.env.CONTROL_DB, {
		limit: Number.isFinite(limit) ? limit : 50,
		offset: Number.isFinite(offset) ? offset : 0,
		resourceType,
		actor,
		fromDate,
		toDate,
	});

	return c.json(result);
});

// HTML Settings Page
app.get("/settings", async (c) => {
	const authCheck = await ensureDashboardAuth(c.req.raw, c.env, {
		pageTitle: "Platform Settings",
		returnPath: "/settings",
	});
	if (authCheck) return authCheck;

	const settings = await getSettings(c.env);
	const settingsJson = JSON.stringify(settings, null, 2);
	const html = renderSettingsHtml({ settingsJson });
	return c.html(html);
});

// HTML Settings Save (proxies to internal logic without requiring API key header)
app.post("/settings", async (c) => {
	const authCheck = await ensureDashboardAuth(c.req.raw, c.env, {
		pageTitle: "Platform Settings",
		returnPath: "/settings",
	});
	if (authCheck) return authCheck;

	let body: Record<string, unknown> = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const updated = await saveSettings(c.env, body, "dashboard");

	await logAuditEvent(c.env.CONTROL_DB, {
		action: "settings.update",
		actor: "dashboard",
		resourceType: "settings",
		details: { changedFields: Object.keys(body) },
	});

	return c.json(updated);
});

// HTML Audit Log Page
app.get("/audit-log", async (c) => {
	const authCheck = await ensureDashboardAuth(c.req.raw, c.env, {
		pageTitle: "Audit Log",
		returnPath: "/audit-log",
	});
	if (authCheck) return authCheck;

	const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);

	const result = await getAuditLog(c.env.CONTROL_DB, {
		limit: Number.isFinite(limit) ? limit : 50,
		offset: Number.isFinite(offset) ? offset : 0,
	});

	const rowsHtml = result.items.map(item => {
		const date = new Date(item.createdAt * 1000).toLocaleString();
		const details = item.details ? `<pre style="margin-top:8px;background:var(--white);padding:8px;border-radius:6px;font-size:0.8rem;overflow-x:auto;">${escapeHtml(JSON.stringify(item.details, null, 2))}</pre>` : "";
		return `<div class="log-item">
			<div class="log-header">
				<span class="log-action">${escapeHtml(item.action)}</span>
				<span class="log-meta">${escapeHtml(item.resourceType)} · ${item.actor ? escapeHtml(item.actor) : "system"} · ${date}</span>
			</div>
			${item.resourceId ? `<div class="log-resource">Resource: ${escapeHtml(item.resourceId)}</div>` : ""}
			${details}
		</div>`;
	}).join("") || '<div class="empty-state">No audit entries found.</div>';

	const prevOffset = Math.max(0, offset - limit);
	const nextOffset = offset + limit;
	const hasNext = result.total > nextOffset;

	const pagination = `<div class="pagination">
		${offset > 0 ? `<a href="/audit-log?offset=${prevOffset}&limit=${limit}" class="btn btn-secondary">← Previous</a>` : `<span></span>`}
		<span>Showing ${offset + 1}-${Math.min(offset + limit, result.total)} of ${result.total}</span>
		${hasNext ? `<a href="/audit-log?offset=${nextOffset}&limit=${limit}" class="btn btn-secondary">Next →</a>` : `<span></span>`}
	</div>`;

	const html = renderAuditLogHtml({ rowsHtml, pagination });
	return c.html(html);
});

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

interface SettingsHtmlParams {
	settingsJson: string;
}

function renderSettingsHtml(p: SettingsHtmlParams): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Uplink Connect - Platform Settings</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=IBM+Plex+Mono:wght@400;500&family=Source+Sans+3:ital,wght@0,200..900;1,200..900&display=swap" rel="stylesheet">
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
			--success: #2D6A4F;
			--danger: #9B2C2C;
		}
		body {
			font-family: 'Source Sans 3', system-ui, sans-serif;
			background: var(--white);
			color: var(--carbon);
			line-height: 1.55;
		}
		h1, h2, h3 { font-family: 'DM Sans', system-ui, sans-serif; font-weight: 600; }
		.mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.9em; }
		.container { max-width: 900px; margin: 0 auto; padding: 24px 24px 48px; }
		header {
			background: linear-gradient(160deg, var(--workbench) 0%, var(--sawdust) 100%);
			border: 1px solid var(--grain);
			border-radius: 14px;
			padding: 24px;
			margin-bottom: 20px;
		}
		header h1 { font-size: 1.5rem; margin-bottom: 4px; }
		header p { color: var(--graphite); font-size: 0.95rem; }
		.nav {
			display: flex;
			gap: 10px;
			margin-bottom: 20px;
			flex-wrap: wrap;
		}
		.nav a, .nav button {
			color: var(--graphite);
			text-decoration: none;
			font-weight: 500;
			font-size: 0.9rem;
			padding: 8px 12px;
			border-radius: 8px;
			background: var(--workbench);
			border: 1px solid var(--grain);
			transition: background .15s ease, color .15s ease;
			cursor: pointer;
		}
		.nav a:hover, .nav button:hover { background: var(--sawdust); color: var(--carbon); }
		.card {
			background: var(--workbench);
			border: 1px solid var(--grain);
			border-radius: 12px;
			padding: 20px;
			margin-bottom: 16px;
		}
		.card h2 { font-size: 1.1rem; margin-bottom: 12px; }
		textarea {
			width: 100%;
			min-height: 400px;
			padding: 14px;
			border: 1px solid var(--grain);
			border-radius: 10px;
			background: var(--white);
			font-family: 'IBM Plex Mono', ui-monospace, monospace;
			font-size: 0.85rem;
			line-height: 1.5;
			resize: vertical;
		}
		textarea:focus {
			outline: none;
			border-color: var(--forge);
			box-shadow: 0 0 0 3px rgba(200,122,66,0.12);
		}
		.btn {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 10px 18px;
			border-radius: 10px;
			border: 1px solid transparent;
			font-weight: 600;
			font-size: 0.95rem;
			cursor: pointer;
		}
		.btn-primary {
			background: var(--forge);
			color: var(--white);
			border-color: var(--forge);
		}
		.btn-primary:hover { background: var(--forge-hover); border-color: var(--forge-hover); }
		.btn-secondary {
			background: var(--white);
			color: var(--carbon);
			border-color: var(--grain);
		}
		.btn-secondary:hover { background: var(--sawdust); }
		.actions { display: flex; gap: 10px; margin-top: 14px; }
		.toast {
			position: fixed;
			top: 16px;
			right: 16px;
			padding: 12px 18px;
			border-radius: 10px;
			background: var(--carbon);
			color: var(--white);
			font-weight: 500;
			box-shadow: 0 10px 30px rgba(0,0,0,0.12);
			transform: translateY(-120%);
			opacity: 0;
			transition: transform .25s ease, opacity .25s ease;
			z-index: 1000;
		}
		.toast.show { transform: translateY(0); opacity: 1; }
		.toast.error { background: var(--danger); }
		.toast.success { background: var(--success); }
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>Platform Settings</h1>
			<p>View and edit platform configuration. Changes are audited.</p>
		</header>

		<div class="nav">
			<a href="/dashboard">Dashboard</a>
			<a href="/scheduler">Scheduler</a>
			<a href="/settings">Settings</a>
			<a href="/audit-log">Audit Log</a>
		</div>

		<div class="card">
			<h2>Settings JSON</h2>
			<textarea id="settingsInput">${escapeHtml(p.settingsJson)}</textarea>
			<div class="actions">
				<button id="saveBtn" class="btn btn-primary">Save Changes</button>
				<a href="/internal/settings" target="_blank" class="btn btn-secondary">View Raw API</a>
			</div>
		</div>
	</div>

	<div id="toast" class="toast"></div>

	<script>
	(function() {
		const settingsInput = document.getElementById('settingsInput');
		const saveBtn = document.getElementById('saveBtn');
		const toast = document.getElementById('toast');

		function showToast(message, type) {
			toast.textContent = message;
			toast.className = 'toast show ' + (type || '');
			setTimeout(() => { toast.className = 'toast'; }, 3000);
		}

		saveBtn.addEventListener('click', async function() {
			try {
				const body = JSON.parse(settingsInput.value);
				saveBtn.disabled = true;
				saveBtn.textContent = 'Saving...';
				const res = await fetch('/settings', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(body)
				});
				if (!res.ok) throw new Error('Save failed');
				showToast('Settings saved', 'success');
			} catch (e) {
				showToast(e.message || 'Invalid JSON or save failed', 'error');
			} finally {
				saveBtn.disabled = false;
				saveBtn.textContent = 'Save Changes';
			}
		});
	})();
	</script>
</body>
</html>`;
}

interface AuditLogHtmlParams {
	rowsHtml: string;
	pagination: string;
}

function renderAuditLogHtml(p: AuditLogHtmlParams): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Uplink Connect - Audit Log</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=IBM+Plex+Mono:wght@400;500&family=Source+Sans+3:ital,wght@0,200..900;1,200..900&display=swap" rel="stylesheet">
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
			line-height: 1.55;
		}
		h1, h2, h3 { font-family: 'DM Sans', system-ui, sans-serif; font-weight: 600; }
		.container { max-width: 900px; margin: 0 auto; padding: 24px 24px 48px; }
		header {
			background: linear-gradient(160deg, var(--workbench) 0%, var(--sawdust) 100%);
			border: 1px solid var(--grain);
			border-radius: 14px;
			padding: 24px;
			margin-bottom: 20px;
		}
		header h1 { font-size: 1.5rem; margin-bottom: 4px; }
		header p { color: var(--graphite); font-size: 0.95rem; }
		.nav {
			display: flex;
			gap: 10px;
			margin-bottom: 20px;
			flex-wrap: wrap;
		}
		.nav a {
			color: var(--graphite);
			text-decoration: none;
			font-weight: 500;
			font-size: 0.9rem;
			padding: 8px 12px;
			border-radius: 8px;
			background: var(--workbench);
			border: 1px solid var(--grain);
			transition: background .15s ease, color .15s ease;
		}
		.nav a:hover { background: var(--sawdust); color: var(--carbon); }
		.log-item {
			background: var(--workbench);
			border: 1px solid var(--grain);
			border-radius: 10px;
			padding: 16px;
			margin-bottom: 12px;
		}
		.log-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			flex-wrap: wrap;
			margin-bottom: 6px;
		}
		.log-action {
			font-weight: 600;
			color: var(--carbon);
		}
		.log-meta {
			font-size: 0.85rem;
			color: var(--graphite);
		}
		.log-resource {
			font-size: 0.85rem;
			color: var(--graphite);
			font-family: 'IBM Plex Mono', monospace;
		}
		.empty-state {
			padding: 28px;
			text-align: center;
			color: var(--graphite);
		}
		.pagination {
			display: flex;
			align-items: center;
			justify-content: space-between;
			margin-top: 20px;
		}
		.btn {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 8px 14px;
			border-radius: 8px;
			border: 1px solid transparent;
			font-weight: 600;
			font-size: 0.9rem;
			text-decoration: none;
			cursor: pointer;
		}
		.btn-secondary {
			background: var(--white);
			color: var(--carbon);
			border-color: var(--grain);
		}
		.btn-secondary:hover { background: var(--sawdust); }
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>Audit Log</h1>
			<p>Record of all operator actions and system changes.</p>
		</header>

		<div class="nav">
			<a href="/dashboard">Dashboard</a>
			<a href="/scheduler">Scheduler</a>
			<a href="/settings">Settings</a>
			<a href="/audit-log">Audit Log</a>
		</div>

		<div>${p.rowsHtml}</div>
		${p.pagination}
	</div>
</body>
</html>`;
}

export default app;
