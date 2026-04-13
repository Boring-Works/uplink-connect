import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * BrowserManagerDO - Inspired by weblinq's coordination patterns
 * 
 * Manages a pool of browser sessions with:
 * - Queueing when capacity is full
 * - Session reuse and assignment
 * - Health tracking and automatic cleanup
 * - Backpressure handling
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

export interface ManagerState {
  maxSessions: number;
  maxQueueSize: number;
  sessionTimeoutMs: number;
  cleanupIntervalMs: number;
  sessions: Map<string, BrowserSession>;
  queue: Array<{
    requestId: string;
    sourceId: string;
    enqueuedAt: number;
  }>;
  stats: {
    totalCreated: number;
    totalReused: number;
    totalCleanedUp: number;
    totalErrors: number;
    peakConcurrent: number;
  };
}

const STATE_KEY = "manager_state";

export class BrowserManagerDO extends DurableObject<Env> {
  private state: ManagerState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    
    this.state = {
      maxSessions: 10,
      maxQueueSize: 50,
      sessionTimeoutMs: 300000, // 5 minutes
      cleanupIntervalMs: 60000, // 1 minute
      sessions: new Map(),
      queue: [],
      stats: {
        totalCreated: 0,
        totalReused: 0,
        totalCleanedUp: 0,
        totalErrors: 0,
        peakConcurrent: 0,
      },
    };

    // Restore persisted state
    ctx.blockConcurrencyWhile(async () => {
      const persisted = await this.ctx.storage.get<ManagerState>(STATE_KEY);
      if (persisted) {
        // Restore Map from plain object
        this.state = {
          ...persisted,
          sessions: new Map(Object.entries(persisted.sessions || {})),
        };
      }
      
      // Start cleanup alarm
      await this.scheduleCleanup();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case "/status":
          return Response.json(this.getStatus());
        
        case "/session/request":
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
          }
          const requestBody = (await request.json()) as { sourceId: string; requestId: string; priority?: number };
          return Response.json(await this.requestSession(requestBody));
        
        case "/session/release":
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
          }
          const releaseBody = (await request.json()) as { sessionId: string; sourceId: string; error?: boolean };
          return Response.json(await this.releaseSession(releaseBody));
        
        case "/session/heartbeat":
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
          }
          const heartbeatBody = (await request.json()) as { sessionId: string; sourceId: string };
          return Response.json(await this.heartbeat(heartbeatBody));
        
        case "/admin/cleanup":
          return Response.json(await this.forceCleanup());
        
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Manager operation failed";
      console.error(`[BrowserManagerDO] ${url.pathname} failed:`, message);
      return new Response(message, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    await this.performCleanup();
    await this.scheduleCleanup();
  }

  private async scheduleCleanup(): Promise<void> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.state.cleanupIntervalMs);
    }
  }

  private getStatus(): object {
    const activeSessions = Array.from(this.state.sessions.values()).filter(
      s => s.status !== "cleanup" && s.status !== "error"
    );
    
    const availableCount = activeSessions.filter(s => s.status === "available").length;
    const assignedCount = activeSessions.filter(s => s.status === "assigned" || s.status === "busy").length;
    
    return {
      sessions: {
        total: this.state.sessions.size,
        available: availableCount,
        assigned: assignedCount,
        max: this.state.maxSessions,
      },
      queue: {
        length: this.state.queue.length,
        max: this.state.maxQueueSize,
      },
      stats: this.state.stats,
      utilization: {
        current: assignedCount / this.state.maxSessions,
        peak: this.state.stats.peakConcurrent / this.state.maxSessions,
      },
    };
  }

  private async requestSession(params: {
    sourceId: string;
    requestId: string;
    priority?: number;
  }): Promise<SessionAssignment> {
    const { sourceId, requestId } = params;
    
    // Check for existing available session
    const availableSession = this.findAvailableSession();
    if (availableSession) {
      // Reuse existing session
      availableSession.status = "assigned";
      availableSession.assignedTo = sourceId;
      availableSession.assignedAt = Date.now();
      availableSession.lastUsedAt = Date.now();
      
      this.state.stats.totalReused++;
      await this.persist();
      
      console.log(`[BrowserManagerDO] Reused session ${availableSession.sessionId} for ${sourceId}`);
      
      return {
        sessionId: availableSession.sessionId,
        assigned: true,
      };
    }
    
    // Check if we can create a new session
    const activeCount = Array.from(this.state.sessions.values()).filter(
      s => s.status !== "cleanup" && s.status !== "error"
    ).length;
    
    if (activeCount < this.state.maxSessions) {
      // Create new session
      const sessionId = crypto.randomUUID();
      const newSession: BrowserSession = {
        sessionId,
        status: "assigned",
        assignedTo: sourceId,
        assignedAt: Date.now(),
        lastUsedAt: Date.now(),
        createdAt: Date.now(),
        errorCount: 0,
      };
      
      this.state.sessions.set(sessionId, newSession);
      this.state.stats.totalCreated++;
      
      if (activeCount + 1 > this.state.stats.peakConcurrent) {
        this.state.stats.peakConcurrent = activeCount + 1;
      }
      
      await this.persist();
      
      console.log(`[BrowserManagerDO] Created new session ${sessionId} for ${sourceId}`);
      
      return {
        sessionId,
        assigned: true,
      };
    }
    
    // At capacity - check queue
    if (this.state.queue.length >= this.state.maxQueueSize) {
      return {
        sessionId: "",
        assigned: false,
        reason: "At capacity and queue is full. Try again later.",
      };
    }
    
    // Add to queue
    this.state.queue.push({
      requestId,
      sourceId,
      enqueuedAt: Date.now(),
    });
    
    await this.persist();
    
    const queuePosition = this.state.queue.length;
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
    
    const session = this.state.sessions.get(sessionId);
    if (!session) {
      return { released: false, reason: "Session not found" };
    }
    
    if (session.assignedTo !== sourceId) {
      return { released: false, reason: "Session not assigned to this source" };
    }
    
    if (error) {
      session.errorCount++;
      if (session.errorCount >= 3) {
        // Too many errors, mark for cleanup
        session.status = "error";
        this.state.stats.totalErrors++;
        console.log(`[BrowserManagerDO] Session ${sessionId} marked error after ${session.errorCount} errors`);
      } else {
        // Return to available pool
        session.status = "available";
        session.assignedTo = undefined;
        session.assignedAt = undefined;
        console.log(`[BrowserManagerDO] Session ${sessionId} returned to pool (error count: ${session.errorCount})`);
      }
    } else {
      // Successful release, return to available pool
      session.status = "available";
      session.assignedTo = undefined;
      session.assignedAt = undefined;
      console.log(`[BrowserManagerDO] Session ${sessionId} released and available`);
    }
    
    await this.persist();
    
    // Try to assign to queued request
    await this.processQueue();
    
    return { released: true };
  }

  private async heartbeat(params: {
    sessionId: string;
    sourceId: string;
  }): Promise<{ ok: boolean }> {
    const { sessionId, sourceId } = params;
    
    const session = this.state.sessions.get(sessionId);
    if (!session || session.assignedTo !== sourceId) {
      return { ok: false };
    }
    
    session.lastUsedAt = Date.now();
    await this.persist();
    
    return { ok: true };
  }

  private async performCleanup(): Promise<void> {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [sessionId, session] of this.state.sessions) {
      // Clean up stale assigned sessions
      if (session.status === "assigned" || session.status === "busy") {
        if (now - session.lastUsedAt > this.state.sessionTimeoutMs) {
          session.status = "cleanup";
          cleanedCount++;
          console.log(`[BrowserManagerDO] Cleaned up stale session ${sessionId}`);
        }
      }
      
      // Clean up error/cleanup sessions after grace period
      if (session.status === "error" || session.status === "cleanup") {
        if (now - session.lastUsedAt > this.state.sessionTimeoutMs * 2) {
          this.state.sessions.delete(sessionId);
          this.state.stats.totalCleanedUp++;
          console.log(`[BrowserManagerDO] Removed session ${sessionId} from registry`);
        }
      }
    }
    
    // Clean up old queue entries
    const maxQueueAgeMs = 300000; // 5 minutes
    const originalQueueLength = this.state.queue.length;
    this.state.queue = this.state.queue.filter(
      req => now - req.enqueuedAt < maxQueueAgeMs
    );
    const droppedFromQueue = originalQueueLength - this.state.queue.length;
    
    if (cleanedCount > 0 || droppedFromQueue > 0) {
      console.log(`[BrowserManagerDO] Cleanup: ${cleanedCount} sessions, ${droppedFromQueue} queue entries`);
      await this.persist();
    }
    
    // Process queue if sessions available
    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    while (this.state.queue.length > 0) {
      const availableSession = this.findAvailableSession();
      if (!availableSession) break;
      
      const queuedRequest = this.state.queue.shift();
      if (!queuedRequest) break;
      
      // Assign session to queued request
      availableSession.status = "assigned";
      availableSession.assignedTo = queuedRequest.sourceId;
      availableSession.assignedAt = Date.now();
      availableSession.lastUsedAt = Date.now();
      
      console.log(`[BrowserManagerDO] Assigned session ${availableSession.sessionId} to queued request from ${queuedRequest.sourceId}`);
    }
    
    await this.persist();
  }

  private async forceCleanup(): Promise<{ cleaned: number; queueCleared: number }> {
    const beforeCount = this.state.sessions.size;
    const beforeQueue = this.state.queue.length;
    
    // Mark all sessions for cleanup
    for (const session of this.state.sessions.values()) {
      session.status = "cleanup";
    }
    
    // Clear queue
    this.state.queue = [];
    
    await this.performCleanup();
    
    return {
      cleaned: beforeCount - this.state.sessions.size,
      queueCleared: beforeQueue,
    };
  }

  private findAvailableSession(): BrowserSession | undefined {
    for (const session of this.state.sessions.values()) {
      if (session.status === "available") {
        return session;
      }
    }
    return undefined;
  }

  private async persist(): Promise<void> {
    // Convert Map to plain object for storage
    const stateToPersist = {
      ...this.state,
      sessions: Object.fromEntries(this.state.sessions),
    };
    await this.ctx.storage.put(STATE_KEY, stateToPersist);
  }
}

// Client helper for coordinating with BrowserManagerDO
export async function requestBrowserSession(
  managerStub: DurableObjectStub,
  params: { sourceId: string; requestId: string }
): Promise<SessionAssignment> {
  const response = await managerStub.fetch("https://browser-manager/session/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  
  if (!response.ok) {
    throw new Error(`Failed to request session: ${response.status}`);
  }
  
  return response.json() as Promise<SessionAssignment>;
}

export async function releaseBrowserSession(
  managerStub: DurableObjectStub,
  params: { sessionId: string; sourceId: string; error?: boolean }
): Promise<{ released: boolean }> {
  const response = await managerStub.fetch("https://browser-manager/session/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  
  if (!response.ok) {
    throw new Error(`Failed to release session: ${response.status}`);
  }
  
  return response.json() as Promise<{ released: boolean }>;
}

export async function heartbeatBrowserSession(
  managerStub: DurableObjectStub,
  params: { sessionId: string; sourceId: string }
): Promise<{ ok: boolean }> {
  const response = await managerStub.fetch("https://browser-manager/session/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  
  if (!response.ok) {
    return { ok: false };
  }
  
  return response.json() as Promise<{ ok: boolean }>;
}

export function getBrowserManagerStub(env: Env): DurableObjectStub {
  // @ts-ignore - BrowserManager binding will be added to Env
  const id = env.BROWSER_MANAGER.idFromName("global");
  // @ts-ignore
  return env.BROWSER_MANAGER.get(id);
}
