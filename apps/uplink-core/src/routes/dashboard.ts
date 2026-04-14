import { Hono } from "hono";
import type { Env } from "../types";
import { toIsoNow } from "@uplink/contracts";
import {
	getSystemMetrics,
	getQueueMetrics,
	getEntityMetrics,
} from "../lib/metrics";
import { listActiveAlerts } from "../lib/alerting";
import {
	getComponentHealth,
	getPipelineTopology,
} from "../lib/health-monitor";

const app = new Hono<{ Bindings: Env }>();

app.get("/internal/dashboard", async (c) => {
	const [
		systemMetrics,
		queueMetrics,
		entityMetrics,
		sources,
		alerts,
	] = await Promise.all([
		getSystemMetrics(c.env.CONTROL_DB),
		getQueueMetrics(c.env.CONTROL_DB),
		getEntityMetrics(c.env.CONTROL_DB),
		c.env.CONTROL_DB.prepare("SELECT source_id, name, type, status FROM source_configs LIMIT 100").all(),
		listActiveAlerts(c.env.CONTROL_DB, { limit: 10 }),
	]);

	const recentRuns = await c.env.CONTROL_DB
		.prepare(`
			SELECT status, COUNT(*) as count
			FROM ingest_runs
			WHERE created_at > unixepoch() - 86400
			GROUP BY status
		`)
		.all();

	const runSummary: Record<string, number> = {};
	for (const row of recentRuns.results ?? []) {
		const status = (row as { status: string; count: number }).status;
		const count = (row as { status: string; count: number }).count;
		runSummary[status] = count;
	}

	return c.json({
		timestamp: toIsoNow(),
		summary: {
			sources: {
				total: sources.results?.length ?? 0,
				active: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "active").length,
				paused: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "paused").length,
			},
			runs24h: runSummary,
			alerts: {
				active: alerts.length,
				critical: alerts.filter(a => a.severity === "critical").length,
			},
		},
		system: systemMetrics,
		queue: queueMetrics,
		entities: entityMetrics,
		activeAlerts: alerts.slice(0, 5),
	});
});

app.get("/internal/dashboard/v2", async (c) => {
	const windowRaw = c.req.query("window") ?? "86400";
	const windowSeconds = Number.parseInt(windowRaw, 10);
	const effectiveWindow = Number.isFinite(windowSeconds) ? windowSeconds : 86400;

	const [
		systemMetrics,
		queueMetrics,
		entityMetrics,
		pipelineTopology,
		components,
		sources,
		alerts,
		recentRuns,
	] = await Promise.all([
		getSystemMetrics(c.env.CONTROL_DB),
		getQueueMetrics(c.env.CONTROL_DB),
		getEntityMetrics(c.env.CONTROL_DB),
		getPipelineTopology(c.env, c.env.CONTROL_DB),
		getComponentHealth(c.env),
		c.env.CONTROL_DB.prepare("SELECT source_id, name, type, status FROM source_configs WHERE deleted_at IS NULL LIMIT 100").all(),
		listActiveAlerts(c.env.CONTROL_DB, { limit: 10 }),
		c.env.CONTROL_DB.prepare(`
			SELECT status, COUNT(*) as count
			FROM ingest_runs
			WHERE created_at > unixepoch() - ?
			GROUP BY status
		`).bind(effectiveWindow).all(),
	]);

	const runSummary: Record<string, number> = {};
	for (const row of recentRuns.results ?? []) {
		const status = (row as { status: string; count: number }).status;
		const count = (row as { status: string; count: number }).count;
		runSummary[status] = count;
	}

	const previousWindowStart = Math.floor(Date.now() / 1000) - effectiveWindow * 2;
	const previousWindowEnd = Math.floor(Date.now() / 1000) - effectiveWindow;

	const previousRuns = await c.env.CONTROL_DB.prepare(`
		SELECT COUNT(*) as count FROM ingest_runs
		WHERE created_at >= ? AND created_at < ?
	`).bind(previousWindowStart, previousWindowEnd).first<{ count: number }>();

	const currentTotal = Object.values(runSummary).reduce((a, b) => a + b, 0);
	const previousTotal = previousRuns?.count ?? 0;
	const runTrend = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;

	return c.json({
		timestamp: toIsoNow(),
		windowSeconds: effectiveWindow,
		summary: {
			sources: {
				total: sources.results?.length ?? 0,
				active: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "active").length,
				paused: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "paused").length,
				degraded: components.filter(c => c.status === "degraded").length,
			},
			runs: {
				current: runSummary,
				trend: {
					percentage: Math.round(runTrend),
					direction: runTrend >= 0 ? "up" : "down",
				},
			},
			alerts: {
				active: alerts.length,
				critical: alerts.filter(a => a.severity === "critical").length,
				warning: alerts.filter(a => a.severity === "warning").length,
			},
		},
		pipeline: pipelineTopology,
		components: components.map(c => ({
			id: c.id,
			name: c.name,
			status: c.status,
			latencyMs: c.latencyMs,
		})),
		system: systemMetrics,
		queue: queueMetrics,
		entities: entityMetrics,
		activeAlerts: alerts.slice(0, 5).map(a => ({
			alertId: a.alertId,
			alertType: a.alertType,
			severity: a.severity,
			message: a.message,
			sourceId: a.sourceId,
			createdAt: a.createdAt,
		})),
	});
});

app.get("/dashboard", async (c) => {
	const effectiveWindow = 86400;

	try {
		const [
			systemMetrics,
			queueMetrics,
			entityMetrics,
			pipelineTopology,
			components,
			sources,
			alerts,
			recentRuns,
		] = await Promise.all([
			getSystemMetrics(c.env.CONTROL_DB),
			getQueueMetrics(c.env.CONTROL_DB),
			getEntityMetrics(c.env.CONTROL_DB),
			getPipelineTopology(c.env, c.env.CONTROL_DB),
			getComponentHealth(c.env),
			c.env.CONTROL_DB.prepare("SELECT source_id, name, type, status FROM source_configs WHERE deleted_at IS NULL LIMIT 100").all(),
			listActiveAlerts(c.env.CONTROL_DB, { limit: 10 }),
			c.env.CONTROL_DB.prepare(`
				SELECT status, COUNT(*) as count
				FROM ingest_runs
				WHERE created_at > unixepoch() - ?
				GROUP BY status
			`).bind(effectiveWindow).all(),
		]);

		const runSummary: Record<string, number> = {};
		for (const row of recentRuns.results ?? []) {
			const status = (row as { status: string; count: number }).status;
			const count = (row as { status: string; count: number }).count;
			runSummary[status] = count;
		}

		const previousWindowStart = Math.floor(Date.now() / 1000) - effectiveWindow * 2;
		const previousWindowEnd = Math.floor(Date.now() / 1000) - effectiveWindow;

		const previousRuns = await c.env.CONTROL_DB.prepare(`
			SELECT COUNT(*) as count FROM ingest_runs
			WHERE created_at >= ? AND created_at < ?
		`).bind(previousWindowStart, previousWindowEnd).first<{ count: number }>();

		const currentTotal = Object.values(runSummary).reduce((a, b) => a + b, 0);
		const previousTotal = previousRuns?.count ?? 0;
		const runTrend = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;

		const data = {
			timestamp: toIsoNow(),
			windowSeconds: effectiveWindow,
			summary: {
				sources: {
					total: sources.results?.length ?? 0,
					active: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "active").length,
					paused: (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "paused").length,
					degraded: components.filter(c => c.status === "degraded").length,
				},
				runs: {
					current: runSummary,
					trend: {
						percentage: Math.round(runTrend),
						direction: runTrend >= 0 ? "up" : "down",
					},
				},
				alerts: {
					active: alerts.length,
					critical: alerts.filter(a => a.severity === "critical").length,
					warning: alerts.filter(a => a.severity === "warning").length,
				},
			},
			pipeline: pipelineTopology,
			components: components.map(c => ({
				id: c.id,
				name: c.name,
				status: c.status,
				latencyMs: c.latencyMs,
			})),
			system: systemMetrics,
			queue: queueMetrics,
			entities: entityMetrics,
			activeAlerts: alerts.slice(0, 5).map(a => ({
				alertId: a.alertId,
				alertType: a.alertType,
				severity: a.severity,
				message: a.message,
				sourceId: a.sourceId,
				createdAt: a.createdAt,
			})),
		};

		const overallStatus = data.pipeline?.overallHealth || 'unknown';
		const totalSources = data.summary.sources.total;
		const activeSources = data.summary.sources.active;
		const pausedSources = data.summary.sources.paused;
		const totalRuns24h = Object.values(data.summary.runs.current).reduce((a, b) => (a as number) + (b as number), 0) as number;
		const runTrendDirection = data.summary.runs.trend.direction;
		const runTrendPct = Math.abs(data.summary.runs.trend.percentage);
		const queueLagMin = Math.round(data.queue.queueLagSeconds / 60);
		const pendingCount = data.queue.pendingCount;
		const processingCount = data.queue.processingCount;
		const activeAlertCount = data.summary.alerts.active;
		const criticalAlertCount = data.summary.alerts.critical;
		const warningAlertCount = data.summary.alerts.warning;

		const pipelineStagesHtml = data.pipeline?.stages.map(stage => {
			const rate = stage.outputRate ? `${stage.outputRate}/hr` : 'N/A';
			return `<div class="stage ${stage.status}"><div class="stage-name">${escapeHtml(stage.name)}</div><div class="stage-rate">${rate}</div></div>`;
		}).join('<span class="arrow">→</span>') || '';

		const componentsHtml = data.components?.map(comp => {
			const icon = comp.status === 'healthy' ? '✓' : comp.status === 'degraded' ? '!' : '✗';
			const bg = comp.status === 'healthy' ? '#065f46' : comp.status === 'degraded' ? '#92400e' : '#991b1b';
			const latency = comp.latencyMs ? ` · ${comp.latencyMs}ms` : '';
			return `<div class="component"><div class="component-icon" style="background: ${bg}">${icon}</div><div class="component-info"><div class="component-name">${escapeHtml(comp.name)}</div><div class="component-status">${comp.status}${latency}</div></div></div>`;
		}).join('') || '';

		const alertsHtml = data.activeAlerts?.length > 0
			? data.activeAlerts.map(alert => {
				const date = new Date(alert.createdAt * 1000).toLocaleString();
				return `<div class="alert-item ${alert.severity}"><div class="alert-title">${escapeHtml(alert.message)}</div><div class="alert-meta">${escapeHtml(alert.alertType)} · ${date}</div></div>`;
			}).join('')
			: '<div style="color: #64748b; padding: 20px;">No active alerts</div>';

		const wsProtocol = c.req.url.startsWith("https:") ? "wss:" : "ws:";
		const wsHost = new URL(c.req.url).host;
		const wsUrl = `${wsProtocol}//${wsHost}/internal/stream/dashboard`;

		const html = renderDashboardHtml({
			overallStatus,
			totalSources,
			activeSources,
			pausedSources,
			totalRuns24h,
			runTrendDirection,
			runTrendPct,
			queueLagMin,
			pendingCount,
			processingCount,
			activeAlertCount,
			criticalAlertCount,
			warningAlertCount,
			pipelineStagesHtml,
			componentsHtml,
			alertsHtml,
			wsUrl,
		});

		return c.html(html);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return c.html(`<!DOCTYPE html>
<html><body style="background:#0f172a;color:#f87171;padding:40px;font-family:sans-serif;">
<h1>Dashboard Error</h1>
<p>${escapeHtml(message)}</p>
<a href="/dashboard" style="color:#60a5fa">Retry</a>
</body></html>`, 500);
	}
});

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

interface DashboardHtmlParams {
	overallStatus: string;
	totalSources: number;
	activeSources: number;
	pausedSources: number;
	totalRuns24h: number;
	runTrendDirection: string;
	runTrendPct: number;
	queueLagMin: number;
	pendingCount: number;
	processingCount: number;
	activeAlertCount: number;
	criticalAlertCount: number;
	warningAlertCount: number;
	pipelineStagesHtml: string;
	componentsHtml: string;
	alertsHtml: string;
	wsUrl: string;
}

function renderDashboardHtml(p: DashboardHtmlParams): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="refresh" content="30">
	<title>Uplink Connect - System Dashboard</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background: #0f172a;
			color: #e2e8f0;
			line-height: 1.6;
		}
		.container { max-width: 1400px; margin: 0 auto; padding: 20px; }
		header {
			background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
			padding: 30px;
			border-radius: 12px;
			margin-bottom: 30px;
			border: 1px solid #475569;
		}
		header h1 {
			font-size: 2rem;
			background: linear-gradient(90deg, #60a5fa, #a78bfa);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
			margin-bottom: 10px;
		}
		.status-badge {
			display: inline-block;
			padding: 6px 12px;
			border-radius: 20px;
			font-size: 0.875rem;
			font-weight: 600;
			text-transform: uppercase;
		}
		.status-healthy { background: #065f46; color: #34d399; }
		.status-degraded { background: #92400e; color: #fbbf24; }
		.status-unhealthy { background: #991b1b; color: #f87171; }
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
			gap: 20px;
			margin-bottom: 30px;
		}
		.card {
			background: #1e293b;
			border-radius: 12px;
			padding: 24px;
			border: 1px solid #334155;
		}
		.card h3 {
			color: #94a3b8;
			font-size: 0.875rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-bottom: 12px;
		}
		.metric {
			font-size: 2.5rem;
			font-weight: 700;
			color: #f8fafc;
		}
		.metric-sub {
			font-size: 0.875rem;
			color: #64748b;
			margin-top: 4px;
		}
		.trend-up { color: #34d399; }
		.trend-down { color: #f87171; }
		.pipeline {
			display: flex;
			align-items: center;
			gap: 10px;
			margin: 20px 0;
			flex-wrap: wrap;
		}
		.stage {
			background: #334155;
			padding: 16px 24px;
			border-radius: 8px;
			text-align: center;
			min-width: 120px;
			border: 2px solid transparent;
		}
		.stage.healthy { border-color: #34d399; }
		.stage.degraded { border-color: #fbbf24; }
		.stage.unhealthy { border-color: #f87171; }
		.stage-name { font-weight: 600; margin-bottom: 4px; }
		.stage-rate { font-size: 0.75rem; color: #94a3b8; }
		.arrow {
			color: #64748b;
			font-size: 1.5rem;
		}
		.alerts {
			margin-top: 20px;
		}
		.alert-item {
			background: #334155;
			padding: 16px;
			border-radius: 8px;
			margin-bottom: 12px;
			border-left: 4px solid;
		}
		.alert-item.critical { border-left-color: #f87171; }
		.alert-item.warning { border-left-color: #fbbf24; }
		.alert-title { font-weight: 600; margin-bottom: 4px; }
		.alert-meta { font-size: 0.875rem; color: #64748b; }
		.components {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
			gap: 12px;
			margin-top: 20px;
		}
		.component {
			background: #334155;
			padding: 16px;
			border-radius: 8px;
			display: flex;
			align-items: center;
			gap: 12px;
		}
		.component-icon {
			width: 40px;
			height: 40px;
			border-radius: 8px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 1.25rem;
		}
		.component-info { flex: 1; }
		.component-name { font-weight: 600; font-size: 0.875rem; }
		.component-status { font-size: 0.75rem; color: #64748b; }
		.refresh-btn {
			background: #3b82f6;
			color: white;
			border: none;
			padding: 12px 24px;
			border-radius: 8px;
			cursor: pointer;
			font-weight: 600;
			margin-top: 20px;
		}
		.refresh-btn:hover { background: #2563eb; }
		.timestamp {
			color: #64748b;
			font-size: 0.875rem;
			margin-top: 10px;
		}
		.nav {
			display: flex;
			gap: 16px;
			margin-bottom: 20px;
			flex-wrap: wrap;
		}
		.nav a {
			color: #60a5fa;
			text-decoration: none;
			font-size: 0.875rem;
		}
		.nav a:hover {
			text-decoration: underline;
		}
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>Uplink Connect</h1>
			<p>Data Ingestion Platform Dashboard</p>
			<span class="status-badge status-${p.overallStatus}">${p.overallStatus}</span>
			<div class="timestamp">Last updated: ${new Date().toLocaleString()} (auto-refreshes every 30s)</div>
		</header>

		<div class="nav">
			<a href="/dashboard">Dashboard</a>
			<a href="/scheduler">Scheduler</a>
			<a href="/internal/dashboard/v2">API (v2)</a>
			<a href="/internal/health/topology">Topology</a>
			<a href="/internal/health/components">Components</a>
			<a href="/internal/settings">Settings</a>
			<a href="/internal/audit-log">Audit Log</a>
		</div>

		<div class="grid">
			<div class="card">
				<h3>Total Sources</h3>
				<div class="metric">${p.totalSources}</div>
				<div class="metric-sub">
					<span class="trend-up">${p.activeSources} active</span> · ${p.pausedSources} paused
				</div>
			</div>
			<div class="card">
				<h3>Runs (24h)</h3>
				<div class="metric">${p.totalRuns24h}</div>
				<div class="metric-sub">
					<span class="${p.runTrendDirection === 'up' ? 'trend-up' : 'trend-down'}">
						${p.runTrendDirection === 'up' ? '↑' : '↓'} ${p.runTrendPct}%
					</span> vs previous period
				</div>
			</div>
			<div class="card">
				<h3>Queue Lag</h3>
				<div class="metric">${p.queueLagMin}m</div>
				<div class="metric-sub">${p.pendingCount} pending · ${p.processingCount} processing</div>
			</div>
			<div class="card">
				<h3>Active Alerts</h3>
				<div class="metric">${p.activeAlertCount}</div>
				<div class="metric-sub">
					<span class="trend-down">${p.criticalAlertCount} critical</span> · ${p.warningAlertCount} warning
				</div>
			</div>
		</div>

		<div class="card">
			<h3>Data Pipeline Flow</h3>
			<div class="pipeline">
				${p.pipelineStagesHtml}
			</div>
		</div>

		<div class="grid">
			<div class="card">
				<h3>Component Health</h3>
				<div class="components">
					${p.componentsHtml}
				</div>
			</div>

			<div class="card">
				<h3>Active Alerts</h3>
				<div class="alerts">
					${p.alertsHtml}
				</div>
			</div>
		</div>

		<form action="/dashboard" method="GET">
			<button type="submit" class="refresh-btn">Refresh Dashboard</button>
		</form>
		<div id="ws-status" style="margin-top: 10px; font-size: 0.75rem; color: #64748b;">Connecting to real-time updates...</div>
	</div>
	<script>
	(function() {
		const wsUrl = '${p.wsUrl}';
		const statusEl = document.getElementById('ws-status');
		let ws;
		let reconnectTimer;

		function connect() {
			ws = new WebSocket(wsUrl);
			ws.onopen = function() {
				statusEl.textContent = 'Live updates connected';
				statusEl.style.color = '#34d399';
				ws.send(JSON.stringify({ type: 'subscribe', topics: ['metrics', 'all'] }));
			};
			ws.onmessage = function(event) {
				try {
					const msg = JSON.parse(event.data);
					if (msg.type === 'metrics' && msg.data) {
						updateMetrics(msg.data);
					}
				} catch (e) {
					console.error('WS parse error:', e);
				}
			};
			ws.onclose = function() {
				statusEl.textContent = 'Reconnecting...';
				statusEl.style.color = '#fbbf24';
				reconnectTimer = setTimeout(connect, 3000);
			};
			ws.onerror = function() {
				statusEl.textContent = 'Connection error';
				statusEl.style.color = '#f87171';
			};
		}

		function updateMetrics(data) {
			if (data.sources && data.sources.total != null) {
				const cards = document.querySelectorAll('.card');
				if (cards[0]) {
					const metric = cards[0].querySelector('.metric');
					if (metric) metric.textContent = data.sources.total;
				}
			}
			if (data.runs24h) {
				const total = Object.values(data.runs24h).reduce((a, b) => a + b, 0);
				const cards = document.querySelectorAll('.card');
				if (cards[1]) {
					const metric = cards[1].querySelector('.metric');
					if (metric) metric.textContent = total;
				}
			}
			if (data.queue) {
				const cards = document.querySelectorAll('.card');
				if (cards[2]) {
					const metric = cards[2].querySelector('.metric');
					const sub = cards[2].querySelector('.metric-sub');
					if (metric) metric.textContent = (data.queue.pending || 0) + 'm';
					if (sub) sub.textContent = (data.queue.pending || 0) + ' pending · ' + (data.queue.processing || 0) + ' processing';
				}
			}
			if (data.alerts) {
				const cards = document.querySelectorAll('.card');
				if (cards[3]) {
					const metric = cards[3].querySelector('.metric');
					if (metric) metric.textContent = data.alerts.active || 0;
				}
			}
		}

		connect();
		window.addEventListener('beforeunload', function() {
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (ws) ws.close();
		});
	})();
	</script>
</body>
</html>`;
}

export default app;
