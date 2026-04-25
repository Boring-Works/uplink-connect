import { DurableObject } from "cloudflare:workers";
import { ulid } from "@uplink/contracts";
import type { Env } from "../types";


/**
 * BrowserManagerDO - Manages a pool of browser sessions with:
 * - Queueing when capacity is full
 * - Session reuse and assignment
 * - Health tracking and automatic cleanup
 * - Backpressure handling
 *
 * Migrated to DO SQL API for structured session storage and querying.
 */

export type BrowserSessionStatus =
  | "available"
  | "assigned"
  | "busy"
  | "cleanup"
  | "error";

export interface BrowserSession {
  sessionId: string;
  status: BrowserSessionStatus;
  assignedTo?: string; // sourceId
  assignedAt?: number;
  lastUsedAt: number;
  createdAt: number;
  errorCount: number;
  metadata?: Record<string, unknown>;
}

export interface SessionAssignment {
  sessionId: string;
  assigned: boolean;
  queuePosition?: number;
  estimatedWaitMs?: number;
  reason?: string;
}

// Backpressure configuration
const CONFIG = {
  maxSessions: 10,
  maxQueueSize: 50,
  sessionTimeoutMs: 300000, // 5 minutes
  cleanupIntervalMs: 60000, // 1 minute
};

// Schema version for migrations
const SCHEMA_VERSION_KEY = "_schema_version";
const CURRENT_SCHEMA_VERSION = 1;

export class BrowserManagerDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      await this.ensureSchema();
      await this.scheduleCleanup();
    });
  }

  private async ensureSchema(): Promise<void> {
    const version = await this.getSchemaVersion();
    if (version >= CURRENT_SCHEMA_VERSION) return;

    // Sessions table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('available', 'assigned', 'busy', 'cleanup', 'error')),
        assigned_to TEXT,
        assigned_at INTEGER,
        last_used_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        error_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT DEFAULT '{}'
      )
    `);

    // Queue table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_queue (
        request_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL
      )
    `);

    // Stats table (single row)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        total_created INTEGER NOT NULL DEFAULT 0,
        total_reused INTEGER NOT NULL DEFAULT 0,
        total_cleaned_up INTEGER NOT NULL DEFAULT 0,
        total_errors INTEGER NOT NULL DEFAULT 0,
        peak_concurrent INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Initialize stats row if not present
    this.sql.exec(`
      INSERT OR IGNORE INTO stats (key, total_created, total_reused, total_cleaned_up, total_errors, peak_concurrent)
      VALUES ('global', 0, 0, 0, 0, 0)
    `);

    // Indexes
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_assigned_to ON sessions(assigned_to)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_last_used ON sessions(last_used_at)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_queue_enqueued ON session_queue(enqueued_at)`);

    await this.setSchemaVersion(CURRENT_SCHEMA_VERSION);
  }

  private getSchemaVersion(): number {
    try {
      const result = this.sql.exec("SELECT value FROM _metadata WHERE key = ?", SCHEMA_VERSION_KEY).one() as { value: string } | null;
      return result ? parseInt(result.value, 10) : 0;
    } catch {
      return 0;
    }
  }

  private async setSchemaVersion(version: number): Promise<void> {
    try {
      this.sql.exec("CREATE TABLE IF NOT EXISTS _metadata (key TEXT PRIMARY KEY, value TEXT)");
    } catch { /* may already exist */ }
    this.sql.exec(
      "INSERT OR REPLACE INTO _metadata (key, value) VALUES (?, ?)",
      SCHEMA_VERSION_KEY,
      String(version)
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Require internal auth for all endpoints except health
    if (url.pathname !== "/status") {
      const internalKey = request.headers.get("x-uplink-internal-key");
      if (!internalKey || internalKey !== this.env.CORE_INTERNAL_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      switch (url.pathname) {
        case "/status":
          return Response.json(this.getStatus());

        case "/session/request": {
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
          }
          const requestBody = (await request.json()) as { sourceId: string; requestId: string; priority?: number };
          return Response.json(await this.ctx.blockConcurrencyWhile(() => this.requestSession(requestBody)));
        }

        case "/session/release": {
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
          }
          const releaseBody = (await request.json()) as { sessionId: string; sourceId: string; error?: boolean };
          return Response.json(await this.ctx.blockConcurrencyWhile(() => this.releaseSession(releaseBody)));
        }

        case "/session/heartbeat": {
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
          }
          const heartbeatBody = (await request.json()) as { sessionId: string; sourceId: string };
          return Response.json(await this.ctx.blockConcurrencyWhile(() => this.heartbeat(heartbeatBody)));
        }

        case "/admin/cleanup":
          return Response.json(await this.ctx.blockConcurrencyWhile(() => this.forceCleanup()));

        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Manager operation failed";
      console.error(`[BrowserManagerDO] ${url.pathname} failed:`, message);
      return new Response(message, { status: 500 });
    }
  }

  // === Native DO RPC methods ===
  // Type-safe access without HTTP fetch

  async requestSessionRpc(params: { sourceId: string; requestId: string; priority?: number }) {
    return this.ctx.blockConcurrencyWhile(() => this.requestSession(params));
  }

  async releaseSessionRpc(params: { sessionId: string; sourceId: string; error?: boolean }) {
    return this.ctx.blockConcurrencyWhile(() => this.releaseSession(params));
  }

  async heartbeatRpc(params: { sessionId: string; sourceId: string }) {
    return this.ctx.blockConcurrencyWhile(() => this.heartbeat(params));
  }

  async getStatusRpc() {
    return this.getStatus();
  }

  async forceCleanupRpc() {
    return this.ctx.blockConcurrencyWhile(() => this.forceCleanup());
  }

  async alarm(): Promise<void> {
    await this.performCleanup();
    await this.scheduleCleanup();
  }

  private async scheduleCleanup(): Promise<void> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + CONFIG.cleanupIntervalMs);
    }
  }

  private getStatus(): object {
    const activeSessions = this.sql.exec(
      `SELECT COUNT(*) as count FROM sessions WHERE status NOT IN ('cleanup', 'error')`
    ).one() as { count: number };

    const availableCount = (this.sql.exec(
      `SELECT COUNT(*) as count FROM sessions WHERE status = 'available'`
    ).one() as { count: number }).count;

    const assignedCount = (this.sql.exec(
      `SELECT COUNT(*) as count FROM sessions WHERE status IN ('assigned', 'busy')`
    ).one() as { count: number }).count;

    const queueLength = (this.sql.exec(
      `SELECT COUNT(*) as count FROM session_queue`
    ).one() as { count: number }).count;

    const stats = this.sql.exec(`SELECT * FROM stats WHERE key = 'global'`).one() as {
      total_created: number;
      total_reused: number;
      total_cleaned_up: number;
      total_errors: number;
      peak_concurrent: number;
    };

    return {
      sessions: {
        total: activeSessions.count,
        available: availableCount,
        assigned: assignedCount,
        max: CONFIG.maxSessions,
      },
      queue: {
        length: queueLength,
        max: CONFIG.maxQueueSize,
      },
      stats: {
        totalCreated: stats.total_created,
        totalReused: stats.total_reused,
        totalCleanedUp: stats.total_cleaned_up,
        totalErrors: stats.total_errors,
        peakConcurrent: stats.peak_concurrent,
      },
      utilization: {
        current: assignedCount / CONFIG.maxSessions,
        peak: stats.peak_concurrent / CONFIG.maxSessions,
      },
    };
  }

  private async requestSession(params: {
    sourceId: string;
    requestId: string;
    priority?: number;
  }): Promise<SessionAssignment> {
    const { sourceId, requestId } = params;
    const now = Date.now();

    // Check for existing available session
    const availableSession = this.sql.exec(
      `SELECT session_id FROM sessions WHERE status = 'available' ORDER BY last_used_at DESC LIMIT 1`
    ).one() as { session_id: string } | null;

    if (availableSession) {
      // Reuse existing session
      this.sql.exec(
        `UPDATE sessions SET status = 'assigned', assigned_to = ?, assigned_at = ?, last_used_at = ?
         WHERE session_id = ?`,
        sourceId, now, now, availableSession.session_id
      );

      this.sql.exec(
        `UPDATE stats SET total_reused = total_reused + 1 WHERE key = 'global'`
      );

      console.log(`[BrowserManagerDO] Reused session ${availableSession.session_id} for ${sourceId}`);

      return {
        sessionId: availableSession.session_id,
        assigned: true,
      };
    }

    // Check if we can create a new session
    const activeCount = (this.sql.exec(
      `SELECT COUNT(*) as count FROM sessions WHERE status NOT IN ('cleanup', 'error')`
    ).one() as { count: number }).count;

    if (activeCount < CONFIG.maxSessions) {
      // Create new session
      const sessionId = ulid();
      this.sql.exec(
        `INSERT INTO sessions (session_id, status, assigned_to, assigned_at, last_used_at, created_at, error_count)
         VALUES (?, 'assigned', ?, ?, ?, ?, 0)`,
        sessionId, sourceId, now, now, now
      );

      this.sql.exec(
        `UPDATE stats SET total_created = total_created + 1 WHERE key = 'global'`
      );

      if (activeCount + 1 > this.getPeakConcurrent()) {
        this.sql.exec(
          `UPDATE stats SET peak_concurrent = ? WHERE key = 'global'`,
          activeCount + 1
        );
      }

      console.log(`[BrowserManagerDO] Created new session ${sessionId} for ${sourceId}`);

      return {
        sessionId,
        assigned: true,
      };
    }

    // At capacity - check queue
    const queueSize = (this.sql.exec(
      `SELECT COUNT(*) as count FROM session_queue`
    ).one() as { count: number }).count;

    if (queueSize >= CONFIG.maxQueueSize) {
      return {
        sessionId: "",
        assigned: false,
        reason: "At capacity and queue is full. Try again later.",
      };
    }

    // Add to queue
    this.sql.exec(
      `INSERT INTO session_queue (request_id, source_id, enqueued_at) VALUES (?, ?, ?)`,
      requestId, sourceId, now
    );

    const newQueueSize = (this.sql.exec(
      `SELECT COUNT(*) as count FROM session_queue`
    ).one() as { count: number }).count;

    const queuePosition = newQueueSize;
    const estimatedWaitMs = queuePosition * 30000; // Rough estimate: 30s per session

    console.log(`[BrowserManagerDO] Queued request ${requestId} for ${sourceId} (position ${queuePosition})`);

    return {
      sessionId: "",
      assigned: false,
      queuePosition,
      estimatedWaitMs,
      reason: "All sessions busy, added to queue",
    };
  }

  private async releaseSession(params: {
    sessionId: string;
    sourceId: string;
    error?: boolean;
  }): Promise<{ released: boolean; reason?: string }> {
    const { sessionId, sourceId, error } = params;

    const session = this.sql.exec(
      `SELECT session_id, assigned_to, error_count, status FROM sessions WHERE session_id = ?`,
      sessionId
    ).one() as { session_id: string; assigned_to: string | null; error_count: number; status: string } | null;

    if (!session) {
      return { released: false, reason: "Session not found" };
    }

    if (session.assigned_to !== sourceId) {
      return { released: false, reason: "Session not assigned to this source" };
    }

    if (error) {
      const newErrorCount = session.error_count + 1;
      if (newErrorCount >= 3) {
        this.sql.exec(
          `UPDATE sessions SET status = 'error', error_count = ? WHERE session_id = ?`,
          newErrorCount, sessionId
        );
        this.sql.exec(
          `UPDATE stats SET total_errors = total_errors + 1 WHERE key = 'global'`
        );
        console.log(`[BrowserManagerDO] Session ${sessionId} marked error after ${newErrorCount} errors`);
      } else {
        this.sql.exec(
          `UPDATE sessions SET status = 'available', assigned_to = NULL, assigned_at = NULL, error_count = ? WHERE session_id = ?`,
          newErrorCount, sessionId
        );
        console.log(`[BrowserManagerDO] Session ${sessionId} returned to pool (error count: ${newErrorCount})`);
      }
    } else {
      this.sql.exec(
        `UPDATE sessions SET status = 'available', assigned_to = NULL, assigned_at = NULL WHERE session_id = ?`,
        sessionId
      );
      console.log(`[BrowserManagerDO] Session ${sessionId} released and available`);
    }

    // Try to assign to queued request
    await this.processQueue();

    return { released: true };
  }

  private async heartbeat(params: {
    sessionId: string;
    sourceId: string;
  }): Promise<{ ok: boolean }> {
    const { sessionId, sourceId } = params;

    const session = this.sql.exec(
      `SELECT session_id, assigned_to FROM sessions WHERE session_id = ?`,
      sessionId
    ).one() as { session_id: string; assigned_to: string | null } | null;

    if (!session || session.assigned_to !== sourceId) {
      return { ok: false };
    }

    this.sql.exec(
      `UPDATE sessions SET last_used_at = ? WHERE session_id = ?`,
      Date.now(), sessionId
    );

    return { ok: true };
  }

  private async performCleanup(): Promise<void> {
    const now = Date.now();
    let cleanedCount = 0;

    // Mark stale assigned sessions as cleanup
    const staleResult = this.sql.exec(
      `UPDATE sessions SET status = 'cleanup'
       WHERE status IN ('assigned', 'busy') AND ? - last_used_at > ?
       RETURNING session_id`,
      now, CONFIG.sessionTimeoutMs
    ) as Iterable<{ session_id: string }>;

    for (const row of staleResult) {
      cleanedCount++;
      console.log(`[BrowserManagerDO] Cleaned up stale session ${row.session_id}`);
    }

    // Remove error/cleanup sessions after grace period
    const removedResult = this.sql.exec(
      `DELETE FROM sessions
       WHERE status IN ('error', 'cleanup') AND ? - last_used_at > ?
       RETURNING session_id`,
      now, CONFIG.sessionTimeoutMs * 2
    ) as Iterable<{ session_id: string }>;

    for (const row of removedResult) {
      cleanedCount++;
      this.sql.exec(
        `UPDATE stats SET total_cleaned_up = total_cleaned_up + 1 WHERE key = 'global'`
      );
      console.log(`[BrowserManagerDO] Removed session ${row.session_id} from registry`);
    }

    // Clean up old queue entries
    const maxQueueAgeMs = 300000; // 5 minutes
    const droppedFromQueue = this.sql.exec(
      `DELETE FROM session_queue WHERE ? - enqueued_at > ?
       RETURNING request_id`,
      now, maxQueueAgeMs
    ) as Iterable<{ request_id: string }>;

    let droppedCount = 0;
    for (const _ of droppedFromQueue) {
      droppedCount++;
    }

    if (cleanedCount > 0 || droppedCount > 0) {
      console.log(`[BrowserManagerDO] Cleanup: ${cleanedCount} sessions, ${droppedCount} queue entries`);
    }

    // Process queue if sessions available
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    while (true) {
      const availableSession = this.sql.exec(
        `SELECT session_id FROM sessions WHERE status = 'available' ORDER BY last_used_at DESC LIMIT 1`
      ).one() as { session_id: string } | null;

      if (!availableSession) break;

      const queuedRequest = this.sql.exec(
        `SELECT request_id, source_id FROM session_queue ORDER BY enqueued_at ASC LIMIT 1`
      ).one() as { request_id: string; source_id: string } | null;

      if (!queuedRequest) break;

      // Assign session to queued request
      const now = Date.now();
      this.sql.exec(
        `UPDATE sessions SET status = 'assigned', assigned_to = ?, assigned_at = ?, last_used_at = ?
         WHERE session_id = ?`,
        queuedRequest.source_id, now, now, availableSession.session_id
      );

      this.sql.exec(
        `DELETE FROM session_queue WHERE request_id = ?`,
        queuedRequest.request_id
      );

      console.log(`[BrowserManagerDO] Assigned session ${availableSession.session_id} to queued request from ${queuedRequest.source_id}`);
    }
  }

  private async forceCleanup(): Promise<{ cleaned: number; queueCleared: number }> {
    const beforeCount = (this.sql.exec(
      `SELECT COUNT(*) as count FROM sessions`
    ).one() as { count: number }).count;

    const beforeQueue = (this.sql.exec(
      `SELECT COUNT(*) as count FROM session_queue`
    ).one() as { count: number }).count;

    // Mark all sessions for cleanup
    this.sql.exec(`UPDATE sessions SET status = 'cleanup'`);

    // Clear queue
    this.sql.exec(`DELETE FROM session_queue`);

    await this.performCleanup();

    const afterCount = (this.sql.exec(
      `SELECT COUNT(*) as count FROM sessions`
    ).one() as { count: number }).count;

    return {
      cleaned: beforeCount - afterCount,
      queueCleared: beforeQueue,
    };
  }

  private getPeakConcurrent(): number {
    const result = this.sql.exec(
      `SELECT peak_concurrent FROM stats WHERE key = 'global'`
    ).one() as { peak_concurrent: number } | null;
    return result?.peak_concurrent ?? 0;
  }
}



