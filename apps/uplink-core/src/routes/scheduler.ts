import { Hono } from "hono";
import type { Env } from "../types";
import {
	listSourceSchedules,
	getSourceSchedule,
	createSourceSchedule,
	updateSourceSchedule,
	deleteSourceSchedule,
} from "../lib/scheduler";
import { getSourceConfigWithPolicy } from "../lib/db";
import { getCoordinatorStub, acquireLease } from "../lib/coordinator-client";
import { toIsoNow } from "@uplink/contracts";
import { ensureDashboardAuth } from "../lib/dashboard-auth";

const app = new Hono<{ Bindings: Env }>();

// API: List schedules
app.get("/internal/schedules", async (c) => {
	const sourceId = c.req.query("sourceId") ?? undefined;
	const enabledOnly = c.req.query("enabledOnly") === "true";
	const schedules = await listSourceSchedules(c.env.CONTROL_DB, { sourceId, enabledOnly });
	return c.json({ schedules });
});

// API: Get single schedule
app.get("/internal/schedules/:scheduleId", async (c) => {
	const schedule = await getSourceSchedule(c.env.CONTROL_DB, c.req.param("scheduleId"));
	if (!schedule) return c.json({ error: "Schedule not found" }, 404);
	return c.json({ schedule });
});

// API: Create schedule
app.post("/internal/schedules", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const sourceId = (body as { sourceId?: string }).sourceId;
	const cronExpression = (body as { cronExpression?: string }).cronExpression;

	if (!sourceId || typeof sourceId !== "string") {
		return c.json({ error: "sourceId is required" }, 400);
	}
	if (!cronExpression || typeof cronExpression !== "string") {
		return c.json({ error: "cronExpression is required" }, 400);
	}
	if (!isValidCronExpression(cronExpression)) {
		return c.json({ error: "Invalid cron expression. Expected 5 fields: * * * * *" }, 400);
	}

	// Validate source exists
	const source = await getSourceConfigWithPolicy(c.env.CONTROL_DB, sourceId);
	if (!source) {
		return c.json({ error: "Source not found" }, 404);
	}

	const schedule = await createSourceSchedule(c.env.CONTROL_DB, {
		sourceId,
		cronExpression,
		enabled: (body as { enabled?: boolean }).enabled,
		label: (body as { label?: string }).label,
	});

	return c.json({ schedule }, 201);
});

// API: Update schedule
app.put("/internal/schedules/:scheduleId", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body !== "object") {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const cronExpression = (body as { cronExpression?: string }).cronExpression;
	if (cronExpression !== undefined && !isValidCronExpression(cronExpression)) {
		return c.json({ error: "Invalid cron expression. Expected 5 fields: * * * * *" }, 400);
	}

	const schedule = await updateSourceSchedule(c.env.CONTROL_DB, c.req.param("scheduleId"), {
		cronExpression,
		enabled: (body as { enabled?: boolean }).enabled,
		label: (body as { label?: string }).label,
	});

	if (!schedule) return c.json({ error: "Schedule not found" }, 404);
	return c.json({ schedule });
});

// API: Delete schedule
app.delete("/internal/schedules/:scheduleId", async (c) => {
	const deleted = await deleteSourceSchedule(c.env.CONTROL_DB, c.req.param("scheduleId"));
	if (!deleted) return c.json({ error: "Schedule not found" }, 404);
	return c.json({ ok: true });
});

// API: Bulk delete schedules
app.post("/internal/schedules/bulk-delete", async (c) => {
	const body = await c.req.json().catch(() => null);
	const ids = (body as { scheduleIds?: string[] })?.scheduleIds;
	if (!Array.isArray(ids) || ids.length === 0) {
		return c.json({ error: "scheduleIds array required" }, 400);
	}
	let deleted = 0;
	for (const id of ids) {
		const result = await deleteSourceSchedule(c.env.CONTROL_DB, id);
		if (result) deleted++;
	}
	return c.json({ ok: true, deleted });
});

// API: Bulk enable/disable schedules
app.post("/internal/schedules/bulk-toggle", async (c) => {
	const body = await c.req.json().catch(() => null);
	const ids = (body as { scheduleIds?: string[] })?.scheduleIds;
	const enabled = (body as { enabled?: boolean }).enabled;
	if (!Array.isArray(ids) || ids.length === 0 || typeof enabled !== "boolean") {
		return c.json({ error: "scheduleIds array and enabled boolean required" }, 400);
	}
	let updated = 0;
	for (const id of ids) {
		const result = await updateSourceSchedule(c.env.CONTROL_DB, id, { enabled });
		if (result) updated++;
	}
	return c.json({ ok: true, updated });
});

// API: Trigger a schedule now (manual run for that schedule's source)
app.post("/internal/schedules/:scheduleId/trigger", async (c) => {
	const schedule = await getSourceSchedule(c.env.CONTROL_DB, c.req.param("scheduleId"));
	if (!schedule) return c.json({ error: "Schedule not found" }, 404);

	const source = await getSourceConfigWithPolicy(c.env.CONTROL_DB, schedule.sourceId);
	if (!source) return c.json({ error: "Source not found" }, 404);

	const coordinator = getCoordinatorStub(c.env, schedule.sourceId);
	const lease = await acquireLease(coordinator, {
		requestedBy: "scheduler-manual",
		ttlSeconds: 300,
	});

	if (!lease.acquired) {
		return c.json({ error: "Could not acquire lease", reason: lease.reason }, 409);
	}
	if (!lease.leaseToken) {
		return c.json({ error: "No lease token returned" }, 500);
	}

	// Fire-and-forget the collection via DO
	const doUrl = new URL(c.req.url);
	doUrl.pathname = `/collect`;
	doUrl.searchParams.set("sourceId", schedule.sourceId);
	doUrl.searchParams.set("leaseToken", lease.leaseToken);
	doUrl.searchParams.set("triggeredBy", "scheduler-manual");

	c.executionCtx.waitUntil(
		coordinator.fetch(doUrl.toString(), { method: "POST" }).catch((err) => {
			console.error("[scheduler] manual trigger failed:", err);
		}),
	);

	return c.json({ ok: true, triggeredAt: toIsoNow(), sourceId: schedule.sourceId });
});

// HTML Scheduler Settings Page
app.post("/scheduler", async (c) => {
	const authCheck = await ensureDashboardAuth(c.req.raw, c.env, {
		pageTitle: "Scheduler Settings",
		returnPath: "/scheduler",
	});
	if (authCheck) return authCheck;
	return c.redirect("/scheduler", 302);
});

app.get("/scheduler", async (c) => {
	const authCheck = await ensureDashboardAuth(c.req.raw, c.env, {
		pageTitle: "Scheduler Settings",
		returnPath: "/scheduler",
	});
	if (authCheck) return authCheck;

	const [schedulesResult, sourcesResult, recentRunsResult] = await Promise.all([
		listSourceSchedules(c.env.CONTROL_DB),
		c.env.CONTROL_DB
			.prepare("SELECT source_id, name, type, status FROM source_configs WHERE deleted_at IS NULL ORDER BY name")
			.all<{ source_id: string; name: string; type: string; status: string }>(),
		c.env.CONTROL_DB
			.prepare(`
				SELECT source_id, status, created_at
				FROM ingest_runs
				ORDER BY created_at DESC
				LIMIT 200
			`)
			.all<{ source_id: string; status: string; created_at: number }>(),
	]);

	const schedules = schedulesResult;
	const sources = (sourcesResult.results ?? []).map((s) => ({
		sourceId: s.source_id,
		name: escapeHtml(s.name),
		type: s.type,
		status: s.status,
	}));

	// Build last run time per source from recent runs
	const lastRunBySource = new Map<string, number>();
	for (const run of (recentRunsResult.results ?? [])) {
		if (!lastRunBySource.has(run.source_id)) {
			lastRunBySource.set(run.source_id, run.created_at);
		}
	}

	const schedulesJson = JSON.stringify(schedules)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\//g, "\\/");
	const sourcesJson = JSON.stringify(sources)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\//g, "\\/");
	const lastRunJson = JSON.stringify(Object.fromEntries(lastRunBySource))
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\//g, "\\/");

	const html = renderSchedulerHtml({ schedulesJson, sourcesJson, lastRunJson });
	return c.html(html);
});

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/\//g, "&#47;");
}

interface SchedulerHtmlParams {
	schedulesJson: string;
	sourcesJson: string;
	lastRunJson: string;
}

function renderSchedulerHtml(p: SchedulerHtmlParams): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Uplink Connect - Scheduler Settings</title>
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
			--warning: #B35900;
			--danger: #9B2C2C;
		}
		body {
			font-family: 'Source Sans 3', system-ui, sans-serif;
			background: var(--white);
			color: var(--carbon);
			line-height: 1.55;
		}
		h1, h2, h3, .display {
			font-family: 'DM Sans', system-ui, sans-serif;
			font-weight: 600;
			letter-spacing: -0.01em;
		}
		.mono {
			font-family: 'IBM Plex Mono', ui-monospace, monospace;
			font-size: 0.9em;
		}
		.container { max-width: 1200px; margin: 0 auto; padding: 28px 24px 48px; }
		header {
			background: linear-gradient(160deg, var(--workbench) 0%, var(--sawdust) 100%);
			border: 1px solid var(--grain);
			border-radius: 14px;
			padding: 28px;
			margin-bottom: 28px;
		}
		header h1 {
			font-size: 1.8rem;
			color: var(--carbon);
			margin-bottom: 6px;
		}
		header p {
			color: var(--graphite);
			font-size: 1rem;
		}
		.nav {
			display: flex;
			gap: 14px;
			margin-bottom: 24px;
			flex-wrap: wrap;
		}
		.nav a {
			color: var(--graphite);
			text-decoration: none;
			font-weight: 500;
			font-size: 0.95rem;
			padding: 8px 12px;
			border-radius: 8px;
			background: var(--workbench);
			border: 1px solid var(--grain);
			transition: background .15s ease, color .15s ease;
		}
		.nav a:hover {
			background: var(--sawdust);
			color: var(--carbon);
		}
		.card {
			background: var(--workbench);
			border: 1px solid var(--grain);
			border-radius: 14px;
			padding: 22px;
			margin-bottom: 20px;
		}
		.card h2 {
			font-size: 1.15rem;
			margin-bottom: 16px;
			color: var(--carbon);
		}
		.form-row {
			display: grid;
			grid-template-columns: 1.4fr 1fr .9fr auto;
			gap: 12px;
			align-items: end;
			margin-bottom: 12px;
		}
		@media (max-width: 760px) {
			.form-row { grid-template-columns: 1fr; }
		}
		label {
			display: block;
			font-size: 0.85rem;
			font-weight: 600;
			color: var(--graphite);
			margin-bottom: 6px;
		}
		input, select {
			width: 100%;
			padding: 10px 12px;
			border: 1px solid var(--grain);
			border-radius: 10px;
			background: var(--white);
			color: var(--carbon);
			font-size: 0.95rem;
			font-family: inherit;
		}
		input:focus, select:focus {
			outline: none;
			border-color: var(--forge);
			box-shadow: 0 0 0 3px rgba(200,122,66,0.12);
		}
		.btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
			padding: 10px 16px;
			border-radius: 10px;
			border: 1px solid transparent;
			font-weight: 600;
			font-size: 0.95rem;
			cursor: pointer;
			transition: transform .05s ease, background .15s ease, border-color .15s ease;
		}
		.btn:active { transform: translateY(1px); }
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
		.btn-danger {
			background: var(--danger);
			color: var(--white);
			border-color: var(--danger);
		}
		.btn-danger:hover { background: #7F1D1D; border-color: #7F1D1D; }
		.btn-sm { padding: 7px 12px; font-size: 0.85rem; border-radius: 8px; }
		.toggle-wrap {
			display: flex;
			align-items: center;
			gap: 10px;
			padding-bottom: 10px;
		}
		.toggle {
			appearance: none;
			width: 44px;
			height: 24px;
			background: var(--grain);
			border-radius: 12px;
			position: relative;
			cursor: pointer;
			transition: background .2s ease;
		}
		.toggle::after {
			content: "";
			position: absolute;
			left: 3px;
			top: 3px;
			width: 18px;
			height: 18px;
			background: var(--white);
			border-radius: 9px;
			transition: transform .2s ease;
		}
		.toggle:checked { background: var(--forge); }
		.toggle:checked::after { transform: translateX(20px); }
		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.95rem;
		}
		th, td {
			padding: 12px 10px;
			text-align: left;
			border-bottom: 1px solid var(--grain);
		}
		th {
			font-weight: 600;
			color: var(--graphite);
			font-size: 0.8rem;
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}
		tr:last-child td { border-bottom: none; }
		.badge {
			display: inline-block;
			padding: 4px 10px;
			border-radius: 8px;
			font-size: 0.8rem;
			font-weight: 600;
		}
		.badge-enabled { background: rgba(45,106,79,0.12); color: var(--success); }
		.badge-disabled { background: rgba(157,44,44,0.10); color: var(--danger); }
		.badge-active { background: rgba(45,106,79,0.12); color: var(--success); }
		.badge-paused { background: rgba(179,89,0,0.12); color: var(--warning); }
		.empty-state {
			padding: 28px;
			text-align: center;
			color: var(--graphite);
		}
		.actions { display: flex; gap: 8px; flex-wrap: wrap; }
		.toast {
			position: fixed;
			top: 18px;
			right: 18px;
			padding: 14px 18px;
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
		.cron-hint {
			font-size: 0.85rem;
			color: var(--graphite);
			margin-top: 10px;
		}
		.cron-hint code {
			background: var(--sawdust);
			padding: 2px 6px;
			border-radius: 6px;
			font-family: 'IBM Plex Mono', ui-monospace, monospace;
		}
		.cron-preview {
			font-size: 0.85rem;
			color: var(--graphite);
			margin-top: 8px;
			padding: 10px 14px;
			background: var(--white);
			border-radius: 8px;
			border: 1px solid var(--grain);
		}
		.cron-preview strong {
			color: var(--carbon);
		}
		.source-health {
			font-size: 0.8rem;
			margin-top: 2px;
		}
		.bulk-bar {
			display: flex;
			align-items: center;
			gap: 10px;
			margin-bottom: 12px;
			padding: 10px 14px;
			background: var(--white);
			border-radius: 8px;
			border: 1px solid var(--grain);
		}
		.bulk-bar.hidden { display: none; }
		.checkbox {
			width: 18px;
			height: 18px;
			accent-color: var(--forge);
			cursor: pointer;
		}
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>Scheduler Settings</h1>
			<p>Configure per-source cron schedules. Enabled schedules run automatically based on their cron expression.</p>
		</header>

		<div class="nav">
			<a href="/dashboard">Dashboard</a>
			<a href="/scheduler">Scheduler</a>
			<a href="/settings">Settings</a>
			<a href="/audit-log">Audit Log</a>
		</div>

		<div class="card">
			<h2>Add Schedule</h2>
			<div class="form-row">
				<div>
					<label for="sourceSelect">Source</label>
					<select id="sourceSelect"></select>
				</div>
				<div>
					<label for="cronInput">Cron Expression</label>
					<input id="cronInput" type="text" placeholder="0 * * * *" value="0 * * * *">
				</div>
				<div>
					<label for="labelInput">Label (optional)</label>
					<input id="labelInput" type="text" placeholder="Hourly fetch">
				</div>
				<div class="toggle-wrap">
					<input id="enabledToggle" class="toggle" type="checkbox" checked>
					<label for="enabledToggle" style="margin:0">Enabled</label>
				</div>
			</div>
			<div id="cronPreview" class="cron-preview" style="display:none;"></div>
			<div class="cron-hint">
				Examples:
				<code>*/5 * * * *</code> every 5 min,
				<code>0 * * * *</code> hourly,
<code>0 */6 * * *</code> every 6 hours,
				<code>0 9 * * *</code> daily at 9am UTC
			</div>
			<div style="margin-top: 14px;">
				<button id="addBtn" class="btn btn-primary">Add Schedule</button>
			</div>
		</div>

		<div class="card">
			<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
				<h2>Active Schedules</h2>
				<div id="bulkBar" class="bulk-bar hidden">
					<span id="bulkCount">0 selected</span>
					<button class="btn btn-sm btn-secondary" onclick="bulkEnable(true)">Enable</button>
					<button class="btn btn-sm btn-secondary" onclick="bulkEnable(false)">Disable</button>
					<button class="btn btn-sm btn-danger" onclick="bulkDelete()">Delete</button>
				</div>
			</div>
			<div id="schedulesTableWrap">
				<div class="empty-state">No schedules configured yet.</div>
			</div>
		</div>
	</div>

	<div id="toast" class="toast"></div>

	<script>
	(function() {
		const schedules = ${p.schedulesJson};
		const sources = ${p.sourcesJson};
		const lastRunBySource = ${p.lastRunJson};

		const sourceSelect = document.getElementById('sourceSelect');
		const cronInput = document.getElementById('cronInput');
		const labelInput = document.getElementById('labelInput');
		const enabledToggle = document.getElementById('enabledToggle');
		const addBtn = document.getElementById('addBtn');
		const tableWrap = document.getElementById('schedulesTableWrap');
		const toast = document.getElementById('toast');
		const cronPreview = document.getElementById('cronPreview');
		const bulkBar = document.getElementById('bulkBar');
		const bulkCount = document.getElementById('bulkCount');

		// Populate source dropdown
		sources.forEach(s => {
			const opt = document.createElement('option');
			opt.value = s.sourceId;
			opt.textContent = s.name + ' (' + s.type + ')';
			sourceSelect.appendChild(opt);
		});

		function showToast(message, type) {
			toast.textContent = message;
			toast.className = 'toast show ' + (type || '');
			setTimeout(() => { toast.className = 'toast'; }, 3000);
		}

		function formatDuration(seconds) {
			if (!seconds || seconds < 60) return 'just now';
			const mins = Math.floor(seconds / 60);
			if (mins < 60) return mins + 'm ago';
			const hrs = Math.floor(mins / 60);
			if (hrs < 24) return hrs + 'h ago';
			const days = Math.floor(hrs / 24);
			return days + 'd ago';
		}

		function getNextRuns(cron, count) {
			const parts = cron.trim().split(/\s+/);
			if (parts.length !== 5) return [];
			const [min, hr, day, month, weekday] = parts;
			const now = new Date();
			const runs = [];
			let d = new Date(now);
			d.setSeconds(0, 0);
			// Simple preview: increment by minute up to 1 year
			while (runs.length < count && d.getFullYear() - now.getFullYear() < 2) {
				d = new Date(d.getTime() + 60000);
				if (d <= now) continue;
				// Very basic matching for preview purposes
				const m = d.getUTCMinutes();
				const h = d.getUTCHours();
				const dom = d.getUTCDate();
				const mo = d.getUTCMonth() + 1;
				const wd = d.getUTCDay();
				if (!matchField(min, m, 0, 59)) continue;
				if (!matchField(hr, h, 0, 23)) continue;
				if (!matchField(day, dom, 1, 31)) continue;
				if (!matchField(month, mo, 1, 12)) continue;
				if (!matchField(weekday, wd, 0, 6)) continue;
				runs.push(new Date(d));
			}
			return runs;
		}

		function matchField(expr, value, min, max) {
			if (expr === '*') return true;
			if (expr === '*/1') return true;
			if (expr.startsWith('*/')) {
				const step = parseInt(expr.slice(2), 10);
				return value % step === 0;
			}
			if (expr.includes(',')) {
				return expr.split(',').some(p => parseInt(p, 10) === value);
			}
			if (expr.includes('-')) {
				const [s, e] = expr.split('-').map(Number);
				return value >= s && value <= e;
			}
			return parseInt(expr, 10) === value;
		}

		function updateCronPreview() {
			const cron = cronInput.value.trim();
			const runs = getNextRuns(cron, 5);
			if (runs.length > 0) {
				cronPreview.style.display = 'block';
				cronPreview.innerHTML = '<strong>Next runs:</strong> <ul style="margin:6px 0 0 18px;">' +
					runs.map(r => '<li>' + r.toISOString().replace('T', ' ').slice(0, 16) + ' UTC</li>').join('') +
					'</ul>';
			} else {
				cronPreview.style.display = 'none';
			}
		}

		cronInput.addEventListener('input', updateCronPreview);
		updateCronPreview();

		function getSelectedIds() {
			return Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.dataset.id);
		}

		function updateBulkBar() {
			const ids = getSelectedIds();
			if (ids.length > 0) {
				bulkBar.classList.remove('hidden');
				bulkCount.textContent = ids.length + ' selected';
			} else {
				bulkBar.classList.add('hidden');
			}
		}

		window.bulkEnable = async function(enabled) {
			const ids = getSelectedIds();
			if (!ids.length) return;
			try {
				const res = await fetch('/internal/schedules/bulk-toggle', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ scheduleIds: ids, enabled })
				});
				if (!res.ok) throw new Error('Bulk update failed');
				ids.forEach(id => {
					const sch = schedules.find(s => s.scheduleId === id);
					if (sch) sch.enabled = enabled;
				});
				renderSchedules();
				showToast('Updated ' + ids.length + ' schedules', 'success');
			} catch (e) {
				showToast('Bulk update failed', 'error');
			}
		};

		window.bulkDelete = async function() {
			const ids = getSelectedIds();
			if (!ids.length) return;
			if (!confirm('Delete ' + ids.length + ' selected schedules?')) return;
			try {
				const res = await fetch('/internal/schedules/bulk-delete', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ scheduleIds: ids })
				});
				if (!res.ok) throw new Error('Bulk delete failed');
				ids.forEach(id => {
					const idx = schedules.findIndex(s => s.scheduleId === id);
					if (idx > -1) schedules.splice(idx, 1);
				});
				renderSchedules();
				showToast('Deleted ' + ids.length + ' schedules', 'success');
			} catch (e) {
				showToast('Bulk delete failed', 'error');
			}
		};

		function renderSchedules() {
			if (!schedules.length) {
				tableWrap.innerHTML = '<div class="empty-state">No schedules configured yet.</div>';
				bulkBar.classList.add('hidden');
				return;
			}
			const rows = schedules.map((sch, idx) => {
				const src = sources.find(s => s.sourceId === sch.sourceId);
				const srcName = src ? src.name : sch.sourceId;
				const srcStatus = src ? src.status : 'unknown';
				const statusBadge = srcStatus === 'active' ? 'badge-active' : srcStatus === 'paused' ? 'badge-paused' : 'badge-disabled';
				const lastRun = lastRunBySource[sch.sourceId];
				const lastRunText = lastRun ? formatDuration(Math.floor(Date.now() / 1000) - lastRun) : '<span style="color:#9A9A9A">Never</span>';
				const nextRuns = getNextRuns(sch.cronExpression, 1);
				const nextRunText = nextRuns.length > 0
					? formatDuration(Math.floor((nextRuns[0].getTime() - Date.now()) / 1000)).replace('ago', '') + '
					: '<span style="color:#9A9A9A">—</span>';
				return '<tr data-index="' + idx + '">' +
					'<td><input type="checkbox" class="checkbox row-checkbox" data-id="' + sch.scheduleId + '" data-index="' + idx + '"></td>' +
					'<td><div style="font-weight:600">' + escapeHtml(srcName) + '</div><div class="mono" style="color:#6B6B6B;font-size:0.85rem">' + escapeHtml(sch.sourceId) + '</div><div class="source-health"><span class="badge ' + statusBadge + '">' + srcStatus + '</span></div></td>' +
					'<td class="mono">' + escapeHtml(sch.cronExpression) + '</td>' +
					'<td>' + (sch.label ? escapeHtml(sch.label) : '<span style="color:#9A9A9A">—</span>') + '</td>' +
					'<td>' + lastRunText + '</td>' +
					'<td>' + nextRunText + '</td>' +
					'<td><span class="badge ' + (sch.enabled ? 'badge-enabled' : 'badge-disabled') + '">' + (sch.enabled ? 'Enabled' : 'Disabled') + '</span></td>' +
					'<td>' +
						'<div class="actions">' +
							'<button class="btn btn-sm btn-secondary toggle-btn" data-id="' + sch.scheduleId + '" data-enabled="' + (sch.enabled ? '1' : '0') + '">' + (sch.enabled ? 'Disable' : 'Enable') + '</button>' +
							'<button class="btn btn-sm btn-secondary trigger-btn" data-id="' + sch.scheduleId + '">Trigger Now</button>' +
							'<button class="btn btn-sm btn-danger delete-btn" data-id="' + sch.scheduleId + '">Delete</button>' +
						'</div>' +
					'</td>' +
				'</tr>';
			}).join('');
			tableWrap.innerHTML = '<table><thead><tr><th><input type="checkbox" class="checkbox" id="selectAll"></th><th>Source</th><th>Cron</th><th>Label</th><th>Last Run</th><th>Next Run</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>';

			// Select all
			document.getElementById('selectAll').addEventListener('change', function() {
				document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = this.checked);
				updateBulkBar();
			});

			tableWrap.querySelectorAll('.row-checkbox').forEach(cb => {
				cb.addEventListener('change', updateBulkBar);
			});

			tableWrap.querySelectorAll('.toggle-btn').forEach(btn => {
				btn.addEventListener('click', async function() {
					const id = this.dataset.id;
					const enable = this.dataset.enabled !== '1';
					try {
						const res = await fetch('/internal/schedules/' + id, {
							method: 'PUT',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ enabled: enable })
						});
						if (!res.ok) throw new Error('Update failed');
						const data = await res.json();
						const sch = schedules.find(s => s.scheduleId === id);
						if (sch) sch.enabled = data.schedule.enabled;
						renderSchedules();
						showToast('Schedule ' + (enable ? 'enabled' : 'disabled'), 'success');
					} catch (e) {
						showToast('Failed to update schedule', 'error');
					}
				});
			});

			tableWrap.querySelectorAll('.trigger-btn').forEach(btn => {
				btn.addEventListener('click', async function() {
					const id = this.dataset.id;
					this.disabled = true;
					this.textContent = 'Triggering...';
					try {
						const res = await fetch('/internal/schedules/' + id + '/trigger', { method: 'POST' });
						if (!res.ok) throw new Error('Trigger failed');
						showToast('Triggered successfully', 'success');
					} catch (e) {
						showToast('Trigger failed', 'error');
					} finally {
						this.disabled = false;
						this.textContent = 'Trigger Now';
					}
				});
			});

			tableWrap.querySelectorAll('.delete-btn').forEach(btn => {
				btn.addEventListener('click', async function() {
					const id = this.dataset.id;
					if (!confirm('Delete this schedule?')) return;
					try {
						const res = await fetch('/internal/schedules/' + id, { method: 'DELETE' });
						if (!res.ok) throw new Error('Delete failed');
						const idx = schedules.findIndex(s => s.scheduleId === id);
						if (idx > -1) schedules.splice(idx, 1);
						renderSchedules();
						showToast('Schedule deleted', 'success');
					} catch (e) {
						showToast('Failed to delete schedule', 'error');
					}
				});
			});
		}

		function escapeHtml(text) {
			const div = document.createElement('div');
			div.textContent = text;
			return div.innerHTML;
		}

		addBtn.addEventListener('click', async function() {
			const sourceId = sourceSelect.value;
			const cronExpression = cronInput.value.trim();
			const label = labelInput.value.trim() || undefined;
			const enabled = enabledToggle.checked;
			if (!sourceId) { showToast('Select a source', 'error'); return; }
			if (!cronExpression) { showToast('Enter a cron expression', 'error'); return; }
			addBtn.disabled = true;
			addBtn.textContent = 'Adding...';
			try {
				const res = await fetch('/internal/schedules', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ sourceId, cronExpression, label, enabled })
				});
				if (!res.ok) {
					const data = await res.json().catch(() => ({}));
					throw new Error(data.error || 'Add failed');
				}
				const data = await res.json();
				schedules.push(data.schedule);
				renderSchedules();
				cronInput.value = '0 * * * *';
				labelInput.value = '';
				enabledToggle.checked = true;
				updateCronPreview();
				showToast('Schedule added', 'success');
			} catch (e) {
				showToast(e.message || 'Failed to add schedule', 'error');
			} finally {
				addBtn.disabled = false;
				addBtn.textContent = 'Add Schedule';
			}
		});

		renderSchedules();
	})();
	</script>
</body>
</html>`;
}

function isValidCronExpression(cron: string): boolean {
	// Basic validation for 5-field cron: minute hour day month weekday
	// Rejects obviously invalid patterns but allows standard cron syntax
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	// Reject shell injection or path traversal attempts
	const forbidden = /[;|&$<>{}[\]\\]/;
	for (const part of parts) {
		if (forbidden.test(part)) return false;
	}
	return true;
}

export default app;
