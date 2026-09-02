import crypto from "node:crypto";
import { AntigravityProcess } from "./antigravity-process.js";
import { logger } from "./logger.js";
import { resolvePermissionSettings } from "./permissions.js";

export interface SessionOptions {
  id?: string;
  cwd?: string;
  model?: string;
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
  public mode: string;
  public readonly createdAt: Date;
  public lastActivity: Date;
  public process: AntigravityProcess;

  constructor(options: SessionOptions = {}) {
    this.id = options.id || crypto.randomUUID();
    this.cwd = options.cwd || process.cwd();
    this.model = options.model || "gemini-3.7-flash-high";
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
      mode: this.mode,
      permissions,
      env: options.env,
    });
  }

  touch() {
    this.lastActivity = new Date();
  }

  async close(): Promise<void> {
    logger.info("Closing session", { sessionId: this.id });
    await this.process.close();
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  createSession(options: SessionOptions = {}): Session {
    const session = new Session(options);
    this.sessions.set(session.id, session);
    logger.info("Created new session", { sessionId: session.id, cwd: session.cwd, model: session.model });
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
