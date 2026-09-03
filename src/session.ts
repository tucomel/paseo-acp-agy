import crypto from "node:crypto";
import { AntigravityProcess } from "./antigravity-process.js";
import { logger } from "./logger.js";
import { resolvePermissionSettings } from "./permissions.js";
import { PersistedSessionState, SessionStore, sessionStore } from "./session-store.js";

export interface SessionOptions {
  id?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  mode?: string;
  conversationId?: string;
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  env?: Record<string, string>;
  binaryPath?: string;
  store?: SessionStore;
}

export class Session {
  public readonly id: string;
  public cwd: string;
  public model: string;
  public effort: string;
  public mode: string;
  public readonly createdAt: Date;
  public lastActivity: Date;
  public isCancelled = false;
  public process: AntigravityProcess;
  private store: SessionStore;
  private promptOperationActive = false;

  constructor(options: SessionOptions = {}) {
    this.id = options.id || crypto.randomUUID();
    this.cwd = options.cwd || process.cwd();
    this.model = options.model || "gemini-3.7-flash";
    this.effort = options.effort || "high";
    this.mode = options.mode || "default";
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.store = options.store || sessionStore;

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
      conversationId: options.conversationId,
      permissions,
      env: options.env,
    });

    this.process.on("init", () => this.persist());
    this.process.on("result", () => this.persist());
    this.persist();
  }

  private persistedState(): PersistedSessionState {
    return {
      sessionId: this.id,
      conversationId: this.process.currentConversationId,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      mode: this.mode,
      updatedAt: new Date().toISOString(),
    };
  }

  persist() {
    this.store.save(this.persistedState());
  }

  get isPromptOperationActive(): boolean {
    return this.promptOperationActive;
  }

  tryBeginPromptOperation(): boolean {
    if (this.promptOperationActive) return false;
    this.promptOperationActive = true;
    this.isCancelled = false;
    return true;
  }

  endPromptOperation(): void {
    this.promptOperationActive = false;
  }

  setModel(model: string) {
    this.model = model;
    this.process.setModel(model);
    this.persist();
  }

  setEffort(effort: string) {
    this.effort = effort;
    this.process.setEffort(effort);
    this.persist();
  }

  setMode(mode: string) {
    this.mode = mode;
    this.process.setMode(mode);
    this.persist();
  }

  setConversationId(conversationId?: string) {
    this.process.setConversationId(conversationId);
    this.persist();
  }

  async ensureReadyForResume(): Promise<void> {
    const conversationId = this.process.currentConversationId;
    if (!conversationId) {
      throw new Error(`ACP session ${this.id} has no persisted Antigravity conversation ID`);
    }
    try {
      await this.process.ensureReady(conversationId);
      this.persist();
    } catch (err) {
      this.persist();
      throw err;
    }
  }

  async resumeConversation(conversationId: string): Promise<void> {
    const previousConversationId = this.process.currentConversationId;
    this.setConversationId(conversationId);
    try {
      await this.ensureReadyForResume();
    } catch (err) {
      // A failed manual /resume must not poison the current Paseo session.
      this.setConversationId(previousConversationId);
      this.persist();
      throw err;
    }
  }

  touch() {
    this.lastActivity = new Date();
  }

  cancelTurn(): boolean {
    const processCancelled = this.process.cancelCurrentTurn();
    const cancelled = this.promptOperationActive || processCancelled;
    if (cancelled) this.isCancelled = true;
    return cancelled;
  }

  async close(): Promise<void> {
    logger.info("Closing session", { sessionId: this.id });
    this.persist();
    this.promptOperationActive = false;
    await this.process.close();
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private defaultBinaryPath?: string;
  private store: SessionStore;

  constructor(options?: { defaultBinaryPath?: string; store?: SessionStore }) {
    this.defaultBinaryPath = options?.defaultBinaryPath;
    this.store = options?.store || sessionStore;
  }

  createSession(options: SessionOptions = {}): Session {
    const persisted = options.id ? this.store.load(options.id) : null;
    if (options.id && !persisted) {
      throw new Error(`Cannot restore unknown ACP session: ${options.id}`);
    }

    const session = new Session({
      id: options.id,
      binaryPath: options.binaryPath || this.defaultBinaryPath,
      cwd: options.cwd || persisted?.cwd,
      model: options.model || persisted?.model,
      effort: options.effort || persisted?.effort,
      mode: options.mode || persisted?.mode,
      conversationId: options.conversationId || persisted?.conversationId,
      sandbox: options.sandbox,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      env: options.env,
      store: this.store,
    });

    this.sessions.set(session.id, session);
    logger.info("Created new session", {
      sessionId: session.id,
      cwd: session.cwd,
      model: session.model,
      effort: session.effort,
      resumedConversation: Boolean(session.process.currentConversationId),
    });
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  hasPersistedSession(id: string): boolean {
    return this.store.load(id) !== null;
  }

  async closeSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.close();
    this.sessions.delete(id);
    return true;
  }

  async closeAll(): Promise<void> {
    logger.info("Closing all active sessions", { count: this.sessions.size });
    await Promise.allSettled(Array.from(this.sessions.values(), (session) => session.close()));
    this.sessions.clear();
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }
}
