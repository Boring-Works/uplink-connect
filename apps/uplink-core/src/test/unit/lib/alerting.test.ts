import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	getDefaultAlertRules,
	parseAlertConfiguration,
	serializeAlertConfiguration,
	createAlert,
	listActiveAlerts,
	acknowledgeAlert,
	resolveAlert,
} from "../../../lib/alerting";

describe("getDefaultAlertRules", () => {
	it("returns 7 default rules", () => {
		const rules = getDefaultAlertRules();
		expect(rules).toHaveLength(7);
	});

	it("includes source_failure_rate rules", () => {
		const rules = getDefaultAlertRules();
		const failureRules = rules.filter((r) => r.alertType === "source_failure_rate");
		expect(failureRules).toHaveLength(2);
		expect(failureRules[0].severity).toBe("warning");
		expect(failureRules[1].severity).toBe("critical");
	});

	it("includes queue_lag rules", () => {
		const rules = getDefaultAlertRules();
		const queueRules = rules.filter((r) => r.alertType === "queue_lag");
		expect(queueRules).toHaveLength(2);
	});

	it("includes run_stuck rules", () => {
		const rules = getDefaultAlertRules();
		const stuckRules = rules.filter((r) => r.alertType === "run_stuck");
		expect(stuckRules).toHaveLength(2);
	});

	it("includes lease_expired rule", () => {
		const rules = getDefaultAlertRules();
		const leaseRules = rules.filter((r) => r.alertType === "lease_expired");
		expect(leaseRules).toHaveLength(1);
		expect(leaseRules[0].severity).toBe("critical");
	});

	it("returns copies of rules (not shared references)", () => {
		const rules1 = getDefaultAlertRules();
		const rules2 = getDefaultAlertRules();
		rules1[0].threshold = 999;
		expect(rules2[0].threshold).not.toBe(999);
	});
});

describe("parseAlertConfiguration", () => {
	it("returns defaults for null input", () => {
		const config = parseAlertConfiguration(null);
		expect(config.alertRules).toHaveLength(7);
		expect(config.notificationChannels).toBeUndefined();
	});

	it("returns defaults for invalid JSON", () => {
		const config = parseAlertConfiguration("not json");
		expect(config.alertRules).toHaveLength(7);
	});

	it("parses valid configuration", () => {
		const json = JSON.stringify({
			alertRules: [
				{
					alertType: "queue_lag",
					severity: "warning",
					threshold: 30,
					windowSeconds: 60,
					enabled: true,
				},
			],
			notificationChannels: {
				webhook: "https://example.com/webhook",
			},
		});
		const config = parseAlertConfiguration(json);
		expect(config.alertRules).toHaveLength(1);
		expect(config.alertRules[0].threshold).toBe(30);
		expect(config.notificationChannels?.webhook).toBe("https://example.com/webhook");
	});

	it("falls back to defaults when alertRules is empty", () => {
		const json = JSON.stringify({ alertRules: [] });
		const config = parseAlertConfiguration(json);
		expect(config.alertRules).toHaveLength(7);
	});

	it("ignores extra properties in parsed config", () => {
		const json = JSON.stringify({
			alertRules: getDefaultAlertRules(),
			extraField: "ignored",
		});
		const config = parseAlertConfiguration(json);
		expect(config.alertRules).toHaveLength(7);
	});
});

describe("serializeAlertConfiguration", () => {
	it("serializes configuration to JSON", () => {
		const config = {
			alertRules: getDefaultAlertRules(),
			notificationChannels: { webhook: "https://example.com/webhook" },
		};
		const json = serializeAlertConfiguration(config);
		const parsed = JSON.parse(json);
		expect(parsed.alertRules).toHaveLength(7);
		expect(parsed.notificationChannels.webhook).toBe("https://example.com/webhook");
	});
});

describe("createAlert", () => {
	it("creates alert in database", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const db = {
			prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run: mockRun }) }),
		} as unknown as D1Database;

		await createAlert(db, {
			alertType: "source_failure_rate",
			severity: "critical",
			sourceId: "src-1",
			message: "High failure rate",
		});

		expect(mockRun).toHaveBeenCalled();
	});
});

describe("listActiveAlerts", () => {
	it("returns empty array when no alerts", async () => {
		const db = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					all: vi.fn().mockResolvedValue({ results: [] }),
				}),
			}),
		} as unknown as D1Database;

		const result = await listActiveAlerts(db, { limit: 10 });
		expect(result).toEqual([]);
	});

	it("returns alerts with default limit", async () => {
		const db = {
			prepare: vi.fn().mockReturnValue({
				bind: vi.fn().mockReturnValue({
					all: vi.fn().mockResolvedValue({
						results: [
							{
								alert_id: "alert-1",
								alert_type: "source_failure_rate",
								severity: "critical",
								source_id: "src-1",
								message: "High failure rate",
								status: "active",
								created_at: 12345,
							},
						],
					}),
				}),
			}),
		} as unknown as D1Database;

		const result = await listActiveAlerts(db);
		expect(result).toHaveLength(1);
		expect(result[0].alertId).toBe("alert-1");
	});
});

describe("acknowledgeAlert", () => {
	it("updates alert status to acknowledged", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const db = {
			prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run: mockRun }) }),
		} as unknown as D1Database;

		await acknowledgeAlert(db, "alert-1", "user-1");
		expect(mockRun).toHaveBeenCalled();
	});
});

describe("resolveAlert", () => {
	it("updates alert status to resolved", async () => {
		const mockRun = vi.fn().mockResolvedValue({ success: true });
		const db = {
			prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run: mockRun }) }),
		} as unknown as D1Database;

		await resolveAlert(db, "alert-1", "user-1");
		expect(mockRun).toHaveBeenCalled();
	});
});


