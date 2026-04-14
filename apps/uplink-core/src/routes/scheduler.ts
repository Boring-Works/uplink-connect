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

	const schedule = await updateSourceSchedule(c.env.CONTROL_DB, c.req.param("scheduleId"), {
		cronExpression: (body as { cronExpression?: string }).cronExpression,
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
app.get("/scheduler", async (c) => {
	const [schedulesResult, sourcesResult] = await Promise.all([
		listSourceSchedules(c.env.CONTROL_DB),
		c.env.CONTROL_DB
			.prepare("SELECT source_id, name, type, status FROM source_configs WHERE deleted_at IS NULL ORDER BY name")
			.all<{ source_id: string; name: string; type: string; status: string }>(),
	]);

	const schedules = schedulesResult;
	const sources = (sourcesResult.results ?? []).map((s) => ({
		sourceId: s.source_id,
		name: escapeHtml(s.name),
		type: s.type,
		status: s.status,
	}));

	const schedulesJson = JSON.stringify(schedules);
	const sourcesJson = JSON.stringify(sources);

	const html = renderSchedulerHtml({ schedulesJson, sourcesJson });
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

interface SchedulerHtmlParams {
	schedulesJson: string;
	sourcesJson: string;
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
		.container { max-width: 1100px; margin: 0 auto; padding: 28px 24px 48px; }
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
			<a href="/internal/settings">Settings API</a>
			<a href="/internal/audit-log">Audit Log</a>
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
			<h2>Active Schedules</h2>
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

		const sourceSelect = document.getElementById('sourceSelect');
		const cronInput = document.getElementById('cronInput');
		const labelInput = document.getElementById('labelInput');
		const enabledToggle = document.getElementById('enabledToggle');
		const addBtn = document.getElementById('addBtn');
		const tableWrap = document.getElementById('schedulesTableWrap');
		const toast = document.getElementById('toast');

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

		function renderSchedules() {
			if (!schedules.length) {
				tableWrap.innerHTML = '<div class="empty-state">No schedules configured yet.</div>';
				return;
			}
			const rows = schedules.map((sch, idx) => {
				const src = sources.find(s => s.sourceId === sch.sourceId);
				const srcName = src ? src.name : sch.sourceId;
				return '\u003ctr data-index="' + idx + '"\u003e' +
					'<td\u003e<div style="font-weight:600">' + escapeHtml(srcName) + '</div><div class="mono" style="color:#6B6B6B;font-size:0.85rem">' + sch.sourceId + '</div></td\u003e' +
					'<td class="mono">' + escapeHtml(sch.cronExpression) + '</td\u003e' +
					'<td\u003e' + (sch.label ? escapeHtml(sch.label) : '<span style="color:#9A9A9A">—</span>') + '</td\u003e' +
					'<td\u003e<span class="badge ' + (sch.enabled ? 'badge-enabled' : 'badge-disabled') + '"\u003e' + (sch.enabled ? 'Enabled' : 'Disabled') + '</span></td\u003e' +
					'<td\u003e' +
						'<div class="actions">' +
							'<button class="btn btn-sm btn-secondary toggle-btn" data-id="' + sch.scheduleId + '" data-enabled="' + (sch.enabled ? '1' : '0') + '"\u003e' + (sch.enabled ? 'Disable' : 'Enable') + '</button\u003e' +
							'<button class="btn btn-sm btn-secondary trigger-btn" data-id="' + sch.scheduleId + '"\u003eTrigger Now</button\u003e' +
							'<button class="btn btn-sm btn-danger delete-btn" data-id="' + sch.scheduleId + '"\u003eDelete</button\u003e' +
						'</div>' +
					'</td\u003e' +
				'</tr\u003e';
			}).join('');
			tableWrap.innerHTML = '<table\u003e<thead><tr><th>Source</th><th>Cron</th><th>Label</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>';

			// Bind actions
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

export default app;
