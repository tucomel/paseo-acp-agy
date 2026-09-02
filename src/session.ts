import crypto from "node:crypto";
import { AntigravityProcess } from "./antigravity-process.js";
import { logger } from "./logger.js";
import { resolvePermissionSettings } from "./permissions.js";

export interface SessionOptions {
  id?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  mode?: string;
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  env?: Record<string, string>;
  binaryPath?: string;
}

export class Session {
  public readonly id: string;
  public cwd: string;
  public model: string;
  public effort: string;
  public mode: string;
  public readonly createdAt: Date;
  public lastActivity: Date;
  public isCancelled: boolean = false;
  public process: AntigravityProcess;

  constructor(options: SessionOptions = {}) {
    this.id = options.id || crypto.randomUUID();
    this.cwd = options.cwd || process.cwd();
    this.model = options.model || "gemini-3.7-flash";
    this.effort = options.effort || "high";
    this.mode = options.mode || "default";
    this.createdAt = new Date();
    this.lastActivity = new Date();

    const permissions = resolvePermissionSettings({
      sandbox: options.sandbox,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      mode: this.mode,
    });

    this.process = new AntigravityProcess({
      binaryPath: options.binaryPath,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      mode: this.mode,
      permissions,
      env: options.env,
    });
  }

  setModel(model: string) {
    this.model = model;
    this.process.setModel(model);
  }

  setEffort(effort: string) {
    this.effort = effort;
    this.process.setEffort(effort);
  }

  setMode(mode: string) {
    this.mode = mode;
    this.process.setMode(mode);
  }

  touch() {
    this.lastActivity = new Date();
  }

  cancelTurn(): boolean {
    this.isCancelled = true;
    return this.process.cancelCurrentTurn();
  }

  async close(): Promise<void> {
    logger.info("Closing session", { sessionId: this.id });
    await this.process.close();
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private defaultBinaryPath?: string;

  constructor(options?: { defaultBinaryPath?: string }) {
    this.defaultBinaryPath = options?.defaultBinaryPath;
  }

  createSession(options: SessionOptions = {}): Session {
    const session = new Session({
      binaryPath: options.binaryPath || this.defaultBinaryPath,
      ...options,
    });
    this.sessions.set(session.id, session);
    logger.info("Created new session", {
      sessionId: session.id,
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
    });
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async closeSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    await session.close();
    this.sessions.delete(id);
    return true;
  }

  async closeAll(): Promise<void> {
    logger.info("Closing all active sessions", { count: this.sessions.size });
    const promises: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      promises.push(session.close());
    }
    await Promise.allSettled(promises);
    this.sessions.clear();
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }
}
