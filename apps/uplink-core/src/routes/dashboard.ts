import { Hono } from "hono";
import type { Env } from "../types";
import { toIsoNow, safeJsonStringify, escapeHtml } from "@uplink/contracts";
import {
	getSystemMetrics,
	getQueueMetrics,
	getEntityMetrics,
	getAggregatedSourceMetrics,
} from "../lib/metrics";
import { listActiveAlerts } from "../lib/alerting";
import {
	getComponentHealth,
	getPipelineTopology,
} from "../lib/health-monitor";
import { ensureDashboardAuth } from "../lib/dashboard-auth";
import { listIngestErrors } from "../lib/db";

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
	const effectiveWindow = Math.max(60, Math.min(Number.isFinite(windowSeconds) ? windowSeconds : 86400, 30 * 86400));

	const [
		systemMetrics,
		queueMetrics,
		entityMetrics,
		pipelineTopology,
		components,
		sources,
		alerts,
		recentRuns,
		errorsResult,
		sourceMetrics,
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
			listIngestErrors(c.env.CONTROL_DB, { status: "pending", limit: 10, offset: 0 }),
		getAggregatedSourceMetrics(c.env.CONTROL_DB, effectiveWindow, 10000).catch(() => []),
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
			errors: {
				pending: errorsResult.total,
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
		recentErrors: errorsResult.errors.map(e => ({
			errorId: e.errorId,
			runId: e.runId,
			sourceId: e.sourceId,
			phase: e.phase,
			errorMessage: e.errorMessage,
			status: e.status,
			retryCount: e.retryCount,
			createdAt: e.createdAt,
		})),
		sourceMetrics: sourceMetrics.map(m => ({
			sourceId: m.sourceId,
			totalRuns: m.totalRuns,
			successCount: m.successCount,
			failureCount: m.failureCount,
			errorCount: m.errorCount,
			avgProcessingMs: m.avgProcessingMs,
		})),
	});
});

app.post("/dashboard", async (c) => {
	const authCheck = await ensureDashboardAuth(c.req.raw, c.env, {
		pageTitle: "Uplink Connect Dashboard",
		returnPath: "/dashboard",
	});
	if (authCheck) return authCheck;
	// If auth passed, redirect back to GET
	return c.redirect("/dashboard", 302);
});

app.get("/dashboard", async (c) => {
	const authCheck = await ensureDashboardAuth(c.req.raw, c.env, {
		pageTitle: "Uplink Connect Dashboard",
		returnPath: "/dashboard",
	});
	if (authCheck) return authCheck;

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
			runRows,
			artifactCount,
			errorsResult,
			sourceMetrics,
			dlqCount,
			oldestStuckRun,
		] = await Promise.all([
			getSystemMetrics(c.env.CONTROL_DB),
			getQueueMetrics(c.env.CONTROL_DB),
			getEntityMetrics(c.env.CONTROL_DB),
			getPipelineTopology(c.env, c.env.CONTROL_DB),
			getComponentHealth(c.env),
			c.env.CONTROL_DB.prepare("SELECT source_id, name, type, status FROM source_configs WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100").all(),
			listActiveAlerts(c.env.CONTROL_DB, { limit: 10 }),
			c.env.CONTROL_DB.prepare(`
				SELECT status, COUNT(*) as count
				FROM ingest_runs
				WHERE created_at > unixepoch() - ?
				GROUP BY status
			`).bind(effectiveWindow).all(),
			c.env.CONTROL_DB.prepare(`
				SELECT run_id, source_id, source_name, status, record_count, created_at
				FROM ingest_runs
				ORDER BY created_at DESC
				LIMIT 10
			`).all(),
			c.env.CONTROL_DB.prepare("SELECT COUNT(*) as count FROM raw_artifacts").first<{ count: number }>(),
		listIngestErrors(c.env.CONTROL_DB, { status: "pending", limit: 10, offset: 0 }),
			getAggregatedSourceMetrics(c.env.CONTROL_DB, effectiveWindow, 10000).catch(() => []),
			c.env.CONTROL_DB.prepare(`
				SELECT COUNT(*) as count FROM ingest_errors WHERE status = 'dead_letter'
			`).first<{ count: number }>(),
			c.env.CONTROL_DB.prepare(`
				SELECT run_id, source_name, status, created_at
				FROM ingest_runs
				WHERE status IN ('enqueued', 'collecting')
				ORDER BY created_at ASC
				LIMIT 1
			`).first<{ run_id: string; source_name: string; status: string; created_at: number }>(),
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

		const overallStatus = pipelineTopology?.overallHealth || "unknown";
		const totalSources = (sources.results ?? []).length;
		const activeSources = (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "active").length;
		const pausedSources = (sources.results ?? []).filter((s: unknown) => (s as { status: string }).status === "paused").length;
		const totalRuns24h = currentTotal;
		const runTrendDirection = runTrend >= 0 ? "up" : "down";
		const runTrendPct = Math.abs(Math.round(runTrend));
		const queueLagMin = Math.round((queueMetrics.queueLagSeconds || 0) / 60);
		const pendingCount = queueMetrics.pendingCount || 0;
		const processingCount = queueMetrics.processingCount || 0;
		const activeAlertCount = alerts.length;
		const criticalAlertCount = alerts.filter(a => a.severity === "critical").length;
		const warningAlertCount = alerts.filter(a => a.severity === "warning").length;
		const pendingErrorCount = errorsResult.total;

		const pipelineStagesHtml = pipelineTopology?.stages.map(stage => {
			const rate = stage.outputRate ? `${stage.outputRate}/hr` : '<span style="color:var(--graphite);font-size:0.75rem;">no data</span>';
			return `<div class="stage ${stage.status}"><div class="stage-name">${escapeHtml(stage.name)}</div><div class="stage-rate">${rate}</div></div>`;
		}).join('<span class="arrow">→</span>') || '<div class="empty-state">Pipeline data unavailable</div>';

		const componentsHtml = components?.map(comp => {
			const icon = comp.status === "healthy" ? "✓" : comp.status === "degraded" ? "!" : "✗";
			const border = comp.status === "healthy" ? "#34d399" : comp.status === "degraded" ? "#fbbf24" : "#f87171";
			const latency = comp.latencyMs ? ` · ${comp.latencyMs}ms` : "";
			return `<div class="component" style="border-color: ${border}"><div class="component-icon" style="border-color: ${border}">${icon}</div><div class="component-info"><div class="component-name">${escapeHtml(comp.name)}</div><div class="component-status">${comp.status}${latency}</div></div></div>`;
		}).join("") || "";

		const alertsHtml = alerts?.length > 0
			? alerts.slice(0, 5).map(alert => {
				const date = new Date(alert.createdAt * 1000).toLocaleString();
				return `<div class="alert-item ${alert.severity}" data-alert-id="${escapeHtml(alert.alertId)}">
					<div class="alert-title">${escapeHtml(alert.message)}</div>
					<div class="alert-meta">${escapeHtml(alert.alertType)} · ${date}</div>
					<div class="alert-actions">
						<button class="btn btn-sm btn-secondary" onclick="ackAlert('${escapeHtml(alert.alertId)}')">Ack</button>
						<button class="btn btn-sm btn-primary" onclick="resolveAlert('${escapeHtml(alert.alertId)}')">Resolve</button>
					</div>
				</div>`;
			}).join("")
			: '<div class="empty-state">No active alerts</div>';

		const sourceMetricsMap = new Map(sourceMetrics.map(m => [m.sourceId, m]));

		const sourcesHtml = (sources.results ?? []).slice(0, 8).map((s: unknown) => {
			const src = s as { source_id: string; name: string; type: string; status: string };
			const statusClass = src.status === "active" ? "status-active" : src.status === "paused" ? "status-paused" : "status-inactive";
			const metrics = sourceMetricsMap.get(src.source_id);
			const successRate = metrics && metrics.totalRuns > 0
				? Math.round((metrics.successCount / metrics.totalRuns) * 100)
				: null;
			const metricsHtml = metrics
				? `<div class="source-metrics">${metrics.totalRuns} runs · ${successRate}% success ${metrics.errorCount > 0 ? `· <span class="trend-down">${metrics.errorCount} errors</span>` : ""}</div>`
				: "";
			return `<div class="source-row">
				<div class="source-info">
					<div class="source-name">${escapeHtml(src.name)}</div>
					<div class="source-meta">${src.type} · <span class="${statusClass}">${src.status}</span></div>
					${metricsHtml}
				</div>
				<div class="source-actions">
					<button class="btn btn-sm btn-secondary" onclick="triggerSource('${escapeHtml(src.source_id)}')">Trigger</button>
				</div>
			</div>`;
		}).join("") || '<div class="empty-state">No sources configured</div>';

		const runsHtml = (runRows.results ?? []).map((r: unknown) => {
			const run = r as { run_id: string; source_id: string; source_name: string; status: string; record_count: number; created_at: number };
			const statusClass = `run-status-${run.status}`;
			const time = new Date(run.created_at * 1000).toLocaleString();
			const shortId = run.run_id.split(':').pop() || run.run_id;
			const replayBtn = run.status === 'failed'
				? `<button class="btn btn-sm btn-secondary" onclick="replayRun('${escapeHtml(run.run_id)}')">Replay</button>`
				: '';
			return `<tr>
				<td><div class="mono" title="${escapeHtml(run.run_id)}">${escapeHtml(shortId.slice(0, 14))}...</div></td>
				<td>${escapeHtml(run.source_name)}</td>
				<td><span class="badge ${statusClass}">${escapeHtml(run.status)}</span></td>
				<td>${run.record_count}</td>
				<td class="mono">${time}</td>
				<td>${replayBtn}</td>
			</tr>`;
		}).join("") || '<tr><td colspan="6" class="empty-state">No runs yet</td></tr>';

		const errorsHtml = errorsResult.errors.length > 0
			? errorsResult.errors.slice(0, 5).map(err => {
				const date = new Date(err.createdAt).toLocaleString();
				const msg = err.errorMessage.length > 80 ? err.errorMessage.slice(0, 80) + "..." : err.errorMessage;
				return `<div class="error-item">
					<div class="error-title">${escapeHtml(msg)}</div>
					<div class="error-meta">${escapeHtml(err.phase)} · ${date} · ${err.retryCount} retries</div>
					<div class="error-actions">
						<button class="btn btn-sm btn-secondary" onclick="retryError('${escapeHtml(err.errorId)}')">Retry</button>
					</div>
				</div>`;
			}).join("")
			: '<div class="empty-state">No pending errors</div>';

		const stuckRunHtml = oldestStuckRun
			? `<div class="stuck-run">Oldest stuck: <span class="mono">${escapeHtml(oldestStuckRun.source_name)}</span> · ${escapeHtml(oldestStuckRun.status)} · ${Math.round((Date.now() / 1000 - oldestStuckRun.created_at) / 60)}m</div>`
			: "";

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
			artifactCount: artifactCount?.count ?? 0,
			pendingErrorCount,
			dlqCount: dlqCount?.count ?? 0,
			pipelineStagesHtml,
			componentsHtml,
			alertsHtml,
			sourcesHtml,
			runsHtml,
			errorsHtml,
			stuckRunHtml,
			entityTotal: entityMetrics.totalEntities ?? 0,
			entityNewToday: entityMetrics.newToday ?? 0,
			wsUrl,
		});

		return c.html(html);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return c.html(`<!DOCTYPE html>
<html><body style="background:#FAFAF8;color:#9B2C2C;padding:40px;font-family:sans-serif;">
<h1>Dashboard Error</h1>
<p>${escapeHtml(message)}</p>
<a href="/dashboard" style="color:#C87A42">Retry</a>
</body></html>`, 500);
	}
});



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
	artifactCount: number;
	pendingErrorCount: number;
	dlqCount: number;
	pipelineStagesHtml: string;
	componentsHtml: string;
	alertsHtml: string;
	sourcesHtml: string;
	runsHtml: string;
	errorsHtml: string;
	stuckRunHtml: string;
	entityTotal: number;
	entityNewToday: number;
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
		.container { max-width: 1400px; margin: 0 auto; padding: 24px 24px 48px; }
		header {
			background: linear-gradient(160deg, var(--workbench) 0%, var(--sawdust) 100%);
			border: 1px solid var(--grain);
			border-radius: 14px;
			padding: 24px;
			margin-bottom: 20px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			flex-wrap: wrap;
		}
		header h1 {
			font-size: 1.6rem;
			color: var(--carbon);
			margin-bottom: 4px;
		}
		header p {
			color: var(--graphite);
			font-size: 0.95rem;
		}
		.status-badge {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 6px 12px;
			border-radius: 8px;
			font-size: 0.8rem;
			font-weight: 600;
			text-transform: uppercase;
			border: 1px solid transparent;
		}
		.status-badge::before {
			content: "";
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: currentColor;
		}
		.status-healthy { background: rgba(45,106,79,0.12); color: var(--success); border-color: rgba(45,106,79,0.2); }
		.status-degraded { background: rgba(179,89,0,0.12); color: var(--warning); border-color: rgba(179,89,0,0.2); }
		.status-unhealthy { background: rgba(155,44,44,0.12); color: var(--danger); border-color: rgba(155,44,44,0.2); }
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			gap: 16px;
			margin-bottom: 20px;
		}
		.card {
			background: var(--workbench);
			border: 1px solid var(--grain);
			border-radius: 12px;
			padding: 18px;
		}
		.card h3 {
			color: var(--graphite);
			font-size: 0.8rem;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			margin-bottom: 10px;
		}
		.metric {
			font-size: 2rem;
			font-weight: 700;
			color: var(--carbon);
		}
		.metric-sub {
			font-size: 0.85rem;
			color: var(--graphite);
			margin-top: 4px;
		}
		.trend-up { color: var(--success); }
		.trend-down { color: var(--danger); }
		.pipeline {
			display: flex;
			align-items: center;
			gap: 10px;
			margin: 16px 0;
			flex-wrap: wrap;
		}
		.stage {
			background: var(--white);
			padding: 14px 18px;
			border-radius: 10px;
			text-align: center;
			min-width: 110px;
			border: 2px solid transparent;
		}
		.stage.healthy { border-color: var(--success); }
		.stage.degraded { border-color: var(--warning); }
		.stage.unhealthy { border-color: var(--danger); }
		.stage-name { font-weight: 600; font-size: 0.9rem; margin-bottom: 4px; }
		.stage-rate { font-size: 0.75rem; color: var(--graphite); }
		.arrow {
			color: var(--grain);
			font-size: 1.25rem;
		}
		.components {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
			gap: 10px;
			margin-top: 14px;
		}
		.component {
			background: var(--white);
			padding: 14px;
			border-radius: 10px;
			display: flex;
			align-items: center;
			gap: 10px;
			border: 1px solid transparent;
		}
		.component-icon {
			width: 34px;
			height: 34px;
			border-radius: 8px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 1rem;
			border: 1px solid currentColor;
		}
		.component-info { flex: 1; }
		.component-name { font-weight: 600; font-size: 0.85rem; }
		.component-status { font-size: 0.75rem; color: var(--graphite); }
		.alert-item {
			background: var(--white);
			padding: 14px;
			border-radius: 10px;
			margin-bottom: 10px;
			border-left: 3px solid;
		}
		.alert-item.critical { border-left-color: var(--danger); }
		.alert-item.warning { border-left-color: var(--warning); }
		.alert-title { font-weight: 600; font-size: 0.9rem; margin-bottom: 4px; }
		.alert-meta { font-size: 0.8rem; color: var(--graphite); margin-bottom: 8px; }
		.alert-actions { display: flex; gap: 8px; }
		.error-item {
			background: var(--white);
			padding: 14px;
			border-radius: 10px;
			margin-bottom: 10px;
			border-left: 3px solid var(--danger);
		}
		.error-title { font-weight: 600; font-size: 0.9rem; margin-bottom: 4px; }
		.error-meta { font-size: 0.8rem; color: var(--graphite); margin-bottom: 8px; }
		.error-actions { display: flex; gap: 8px; }
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
		.nav a:hover, .nav button:hover {
			background: var(--sawdust);
			color: var(--carbon);
		}
		.source-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 12px 0;
			border-bottom: 1px solid var(--grain);
		}
		.source-row:last-child { border-bottom: none; }
		.source-name { font-weight: 600; font-size: 0.9rem; }
		.source-meta { font-size: 0.8rem; color: var(--graphite); margin-top: 2px; }
		.source-metrics { font-size: 0.75rem; color: var(--graphite); margin-top: 2px; }
		.status-active { color: var(--success); font-weight: 600; }
		.status-paused { color: var(--warning); font-weight: 600; }
		.status-inactive { color: var(--graphite); }
		.btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
			padding: 8px 14px;
			border-radius: 8px;
			border: 1px solid transparent;
			font-weight: 600;
			font-size: 0.9rem;
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
		.btn-sm { padding: 6px 10px; font-size: 0.8rem; }
		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.9rem;
		}
		th, td {
			padding: 10px;
			text-align: left;
			border-bottom: 1px solid var(--grain);
		}
		th {
			font-weight: 600;
			color: var(--graphite);
			font-size: 0.75rem;
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}
		tr:last-child td { border-bottom: none; }
		.badge {
			display: inline-block;
			padding: 3px 8px;
			border-radius: 6px;
			font-size: 0.75rem;
			font-weight: 600;
		}
		.run-status-received { background: rgba(61,61,61,0.1); color: var(--graphite); }
		.run-status-collecting { background: rgba(200,122,66,0.15); color: var(--forge); }
		.run-status-enqueued { background: rgba(179,89,0,0.12); color: var(--warning); }
		.run-status-persisted { background: rgba(45,106,79,0.12); color: var(--success); }
		.run-status-normalized { background: rgba(45,106,79,0.15); color: var(--success); }
		.run-status-replayed { background: rgba(61,61,61,0.12); color: var(--graphite); }
		.run-status-failed { background: rgba(155,44,44,0.12); color: var(--danger); }
		.empty-state {
			padding: 20px;
			text-align: center;
			color: var(--graphite);
			font-size: 0.9rem;
		}
		.toast {
			position: fixed;
			top: 16px;
			right: 16px;
			padding: 12px 16px;
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
		#ws-status {
			font-size: 0.8rem;
			color: var(--graphite);
			margin-top: 8px;
			padding: 6px 10px;
			border-radius: 6px;
			display: inline-block;
		}
		.ws-connected { background: rgba(45,106,79,0.1); color: var(--success); }
		.ws-reconnecting { background: rgba(179,89,0,0.1); color: var(--warning); }
		.ws-error { background: rgba(155,44,44,0.1); color: var(--danger); }
		.section-title {
			font-size: 1rem;
			font-weight: 600;
			margin-bottom: 10px;
			color: var(--carbon);
		}
		.stuck-run {
			font-size: 0.85rem;
			color: var(--warning);
			margin-top: 8px;
			padding: 8px 12px;
			background: rgba(179,89,0,0.08);
			border-radius: 8px;
		}
		.dashboard-grid {
			display: grid;
			grid-template-columns: repeat(12, 1fr);
			gap: 16px;
		}
		.dashboard-grid .card {
			grid-column: span 6;
		}
		@media (max-width: 900px) {
			.dashboard-grid .card { grid-column: span 12; }
		}
		.metric-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
			gap: 12px;
			margin-bottom: 16px;
		}
		.metric-row .card { margin-bottom: 0; }
	</style>
</head>
<body>
	<div class="container">
		<header>
			<div>
				<h1>Uplink Connect</h1>
				<p>Data Ingestion Platform Dashboard</p>
			</div>
			<span class="status-badge status-${escapeHtml(p.overallStatus)}">${escapeHtml(p.overallStatus)}</span>
		</header>

		<div class="nav">
			<a href="/dashboard">Dashboard</a>
			<a href="/scheduler">Scheduler</a>
			<a href="/settings">Settings</a>
			<a href="/audit-log">Audit Log</a>
			<button onclick="location.reload()">Refresh</button>
		</div>

		<div class="metric-row">
			<div class="card" data-metric="sources">
				<h3>Total Sources</h3>
				<div class="metric">${p.totalSources}</div>
				<div class="metric-sub">
					<span class="trend-up">${p.activeSources} active</span> · ${p.pausedSources} paused
				</div>
			</div>
			<div class="card" data-metric="runs">
				<h3>Runs (24h)</h3>
				<div class="metric">${p.totalRuns24h}</div>
				<div class="metric-sub">
					<span class="${p.runTrendDirection === 'up' ? 'trend-up' : 'trend-down'}">
						${p.runTrendDirection === 'up' ? '&#8593;' : '&#8595;'} ${p.runTrendPct}%
					</span> vs previous period
				</div>
			</div>
			<div class="card" data-metric="queue">
				<h3>Queue Lag</h3>
				<div class="metric">${p.queueLagMin}m</div>
				<div class="metric-sub">${p.pendingCount} pending · ${p.processingCount} processing</div>
				${p.stuckRunHtml}
			</div>
			<div class="card" data-metric="alerts">
				<h3>Active Alerts</h3>
				<div class="metric">${p.activeAlertCount}</div>
				<div class="metric-sub">
					<span class="trend-down">${p.criticalAlertCount} critical</span> · ${p.warningAlertCount} warning
				</div>
			</div>
			<div class="card" data-metric="errors">
				<h3>Pending Errors</h3>
				<div class="metric">${p.pendingErrorCount}</div>
				<div class="metric-sub">${p.dlqCount} in DLQ</div>
			</div>
			<div class="card" data-metric="entities">
				<h3>Entities</h3>
				<div class="metric">${p.entityTotal}</div>
				<div class="metric-sub">+${p.entityNewToday} new today · ${p.artifactCount} artifacts</div>
			</div>
		</div>

		<div class="card">
			<h3>Data Pipeline Flow</h3>
			<div class="pipeline">
				${p.pipelineStagesHtml}
			</div>
		</div>

		<div class="dashboard-grid">
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
			<div class="card">
				<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
					<h3>Sources</h3>
					<a href="/scheduler" style="font-size:0.8rem;color:var(--forge);font-weight:600;">Manage &#8594;</a>
				</div>
				<div>${p.sourcesHtml}</div>
			</div>
			<div class="card">
				<h3>Recent Runs</h3>
				<div style="overflow-x:auto;">
					<table>
						<thead>
							<tr><th>Run</th><th>Source</th><th>Status</th><th>Records</th><th>Time</th><th>Action</th></tr>
						</thead>
						<tbody>${p.runsHtml}</tbody>
					</table>
				</div>
			</div>
			<div class="card" style="grid-column: span 12;">
				<h3>Recent Errors</h3>
				<div>${p.errorsHtml}</div>
			</div>
		</div>

		<div id="ws-status">Connecting to real-time updates...</div>
	</div>

	<div id="toast" class="toast"></div>

	<script>
	(function() {
		const wsUrl = '${escapeHtml(p.wsUrl)}';
		const statusEl = document.getElementById('ws-status');
		const toast = document.getElementById('toast');
		let ws;
		let reconnectTimer;
		let heartbeatTimer;
		let reconnectDelay = 3000;
		let wasConnected = false;

		function showToast(message, type) {
			toast.textContent = message;
			toast.className = 'toast show ' + (type || '');
			setTimeout(() => { toast.className = 'toast'; }, 3000);
		}

		window.triggerSource = async function(sourceId) {
			try {
				const res = await fetch('/internal/sources/' + sourceId + '/trigger', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ triggeredBy: 'dashboard' })
				});
				if (!res.ok) throw new Error('Trigger failed');
				showToast('Triggered ' + sourceId, 'success');
			} catch (e) {
				showToast('Trigger failed', 'error');
			}
		};

		window.replayRun = async function(runId) {
			try {
				const res = await fetch('/internal/runs/' + runId + '/replay', { method: 'POST' });
				if (!res.ok) throw new Error('Replay failed');
				showToast('Replay initiated', 'success');
			} catch (e) {
				showToast('Replay failed', 'error');
			}
		};

		window.retryError = async function(errorId) {
			try {
				const res = await fetch('/internal/errors/' + errorId + '/retry', { method: 'POST' });
				if (!res.ok) throw new Error('Retry failed');
				showToast('Retry initiated', 'success');
				setTimeout(() => location.reload(), 1500);
			} catch (e) {
				showToast('Retry failed', 'error');
			}
		};

		window.ackAlert = async function(alertId) {
			try {
				const res = await fetch('/internal/alerts/' + alertId + '/acknowledge', { method: 'POST' });
				if (!res.ok) throw new Error('Ack failed');
				showToast('Alert acknowledged', 'success');
				const el = document.querySelector('.alert-item[data-alert-id="' + alertId + '"]');
				if (el) el.style.opacity = '0.5';
			} catch (e) {
				showToast('Ack failed', 'error');
			}
		};

		window.resolveAlert = async function(alertId) {
			try {
				const res = await fetch('/internal/alerts/' + alertId + '/resolve', { method: 'POST' });
				if (!res.ok) throw new Error('Resolve failed');
				showToast('Alert resolved', 'success');
				const el = document.querySelector('.alert-item[data-alert-id="' + alertId + '"]');
				if (el) el.remove();
			} catch (e) {
				showToast('Resolve failed', 'error');
			}
		};

		function clearTimers() {
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
		}

		function connect() {
			clearTimers();
			ws = new WebSocket(wsUrl);

			ws.onopen = function() {
				wasConnected = true;
				reconnectDelay = 3000;
				statusEl.textContent = 'Live updates connected';
				statusEl.className = 'ws-connected';
				ws.send(JSON.stringify({ type: 'subscribe', topics: ['metrics', 'all'] }));
				heartbeatTimer = setInterval(function() {
					if (ws && ws.readyState === WebSocket.OPEN) {
						ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
					}
				}, 15000);
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
				clearTimers();
				if (wasConnected) {
					statusEl.textContent = 'Reconnecting...';
					statusEl.className = 'ws-reconnecting';
				} else {
					statusEl.textContent = 'Connecting to real-time updates...';
					statusEl.className = 'ws-reconnecting';
				}
				reconnectTimer = setTimeout(function() {
					reconnectDelay = Math.min(reconnectDelay * 2, 30000);
					connect();
				}, reconnectDelay);
			};

			ws.onerror = function() {
				statusEl.textContent = 'Connection error';
				statusEl.className = 'ws-error';
			};
		}

		function updateMetric(name, value) {
			const card = document.querySelector('.card[data-metric="' + name + '"]');
			if (card) {
				const metric = card.querySelector('.metric');
				if (metric) metric.textContent = value;
			}
		}

		function updateMetrics(data) {
			if (data.sources && data.sources.total != null) {
				updateMetric('sources', data.sources.total);
			}
			if (data.runs24h) {
				const total = Object.values(data.runs24h).reduce((a, b) => a + b, 0);
				updateMetric('runs', total);
			}
			if (data.queue && data.queue.lagSeconds != null) {
				updateMetric('queue', Math.round(data.queue.lagSeconds / 60) + 'm');
			}
			if (data.alerts) {
				updateMetric('alerts', data.alerts.active || 0);
			}
			if (data.errors) {
				updateMetric('errors', data.errors.pending || 0);
			}
		}

		connect();
		window.addEventListener('beforeunload', function() {
			clearTimers();
			if (ws) ws.close();
		});
	})();
	</script>
</body>
</html>`;
}

export default app;
