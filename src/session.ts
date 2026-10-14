import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AntigravityProcess } from "./antigravity-process.js";
import { logger } from "./logger.js";
import { resolvePermissionSettings } from "./permissions.js";
import { calculateUsageCostUsd, getModelContextWindow, SessionInfo } from "./protocol.js";
import {
  PersistedSessionState,
  SessionStore,
  SessionUsageState,
  sessionStore,
} from "./session-store.js";
import { resolveConversationBrainDir } from "./transcript.js";
import {
  loadNativeAntigravitySessions,
  getNativeAntigravitySession,
} from "./native-sessions.js";

export interface SessionOptions {
  id?: string;
  cwd?: string;
  title?: string;
  model?: string;
  effort?: string;
  mode?: string;
  permission?: string;
  conversationId?: string;
  usage?: SessionUsageState;
  updatedAt?: string;
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  env?: Record<string, string>;
  binaryPath?: string;
  store?: SessionStore;
}

export class Session {
  public readonly id: string;
  public cwd: string;
  public title?: string;
  public model: string;
  public effort: string;
  public mode: string;
  public permission: string;
  public readonly createdAt: Date;
  public lastActivity: Date;
  public updatedAt: string;
  public isCancelled = false;
  public process: AntigravityProcess;
  public usage: SessionUsageState;
  private store: SessionStore;
  private promptOperationActive = false;

  constructor(options: SessionOptions = {}) {
    this.id = options.id || crypto.randomUUID();
    this.cwd = options.cwd || process.cwd();
    this.title = options.title;
    this.model = options.model || "gemini-3.8-flash";
    this.effort = options.effort || "high";
    this.mode = options.mode || "default";
    this.permission =
      options.permission ||
      (options.sandbox ? "sandbox" : options.dangerouslySkipPermissions ? "bypass" : "default");
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.updatedAt = options.updatedAt || new Date().toISOString();
    this.store = options.store || sessionStore;
    const maxTokens = getModelContextWindow(this.model);
    this.usage = options.usage
      ? { ...options.usage }
      : {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          contextWindowUsedTokens: 0,
          contextWindowMaxTokens: maxTokens,
        };
    this.usage.contextWindowMaxTokens = maxTokens;
    if (this.usage.contextWindowUsedTokens > maxTokens) {
      this.usage.contextWindowUsedTokens = Math.min(this.usage.contextWindowUsedTokens, maxTokens);
    }

    const isSandbox = this.permission === "sandbox" || options.sandbox;
    const isBypass = this.permission === "bypass" || options.dangerouslySkipPermissions;

    const permissions = resolvePermissionSettings({
      sandbox: isSandbox,
      dangerouslySkipPermissions: isBypass,
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
    this.process.on("conversation_healed", () => this.persist());
    this.persist();
  }

  private persistedState(): PersistedSessionState {
    return {
      sessionId: this.id,
      conversationId: this.process.currentConversationId,
      cwd: this.cwd,
      title: this.title,
      model: this.model,
      effort: this.effort,
      mode: this.mode,
      permission: this.permission,
      usage: this.usage,
      updatedAt: this.updatedAt,
    };
  }

  setTitle(title: string): void {
    if (this.title !== title) {
      this.title = title;
      this.persist();
    }
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
    this.usage.contextWindowMaxTokens = getModelContextWindow(model);
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

  setPermission(permission: string) {
    this.permission = permission;
    const isSandbox = permission === "sandbox";
    const isBypass = permission === "bypass";
    this.process.setPermissions({
      sandbox: isSandbox,
      dangerouslySkipPermissions:
        isBypass || (!isSandbox && this.process.currentPermissions.dangerouslySkipPermissions),
    });
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

  recordTurnUsage(
    turnUsage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    },
    executingModel: string = this.model,
    latestStepContextTokens?: number,
    numSteps = 1
  ) {
    if (!turnUsage) return;
    const input = turnUsage.input_tokens || 0;
    const output = turnUsage.output_tokens || 0;
    const cached = turnUsage.cache_read_tokens || 0;
    const turnCost = calculateUsageCostUsd(executingModel, input, output, cached);

    this.usage.inputTokens += input;
    this.usage.outputTokens += output;
    this.usage.cachedInputTokens += cached;
    this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;
    // Keep the accumulator unrounded. Micro-costs must survive across turns.
    this.usage.totalCostUsd += turnCost;

    // Keep the stored meter aligned with the model currently selected for next turn,
    // but evaluate turn occupancy against the model that executed this turn.
    const executingMaxTokens = getModelContextWindow(executingModel);
    this.usage.contextWindowMaxTokens = getModelContextWindow(this.model);

    // Context window represents the active prompt memory buffer of the model.
    // If we observed the latest step's context window size, use it directly.
    // Otherwise, if input + output exceeds executingMaxTokens, it is an accumulation
    // across multiple steps in the turn; derive the single-step context footprint.
    let activeContextTokens = latestStepContextTokens;
    if (!activeContextTokens || activeContextTokens <= 0) {
      const rawTurnTokens = input + output;
      if (rawTurnTokens > executingMaxTokens && numSteps > 1) {
        activeContextTokens = Math.round(rawTurnTokens / numSteps);
      } else if (rawTurnTokens > executingMaxTokens) {
        activeContextTokens = Math.min(Math.round(rawTurnTokens / 10), executingMaxTokens);
      } else {
        activeContextTokens = rawTurnTokens;
      }
    }

    this.usage.contextWindowUsedTokens = Math.min(activeContextTokens, executingMaxTokens);
    this.lastActivity = new Date();
    this.updatedAt = this.lastActivity.toISOString();
    this.persist();
  }

  touch() {
    this.lastActivity = new Date();
    this.updatedAt = this.lastActivity.toISOString();
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
    const native = options.id ? getNativeAntigravitySession(options.id) : null;
    const brainDir = options.id ? resolveConversationBrainDir(options.id) : null;
    const hasBrainDir = Boolean(brainDir && fs.existsSync(brainDir));

    if (options.id && !persisted && !native && !hasBrainDir) {
      throw new Error(`Cannot restore unknown ACP session: ${options.id}`);
    }

    const session = new Session({
      id: options.id,
      binaryPath: options.binaryPath || this.defaultBinaryPath,
      cwd: options.cwd || persisted?.cwd || (native?.cwd ?? undefined),
      title: options.title || persisted?.title || (native?.title ?? undefined),
      model: options.model || persisted?.model,
      effort: options.effort || persisted?.effort,
      mode: options.mode || persisted?.mode,
      permission: options.permission || persisted?.permission,
      conversationId:
        options.conversationId ||
        persisted?.conversationId ||
        (options.id && (hasBrainDir || native) ? options.id : undefined),
      usage: options.usage || persisted?.usage,
      updatedAt: options.updatedAt || persisted?.updatedAt || (native?.updatedAt ?? undefined),
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

  listActiveSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  listSessions(cwd?: string): SessionInfo[] {
    const sessionMap = new Map<string, SessionInfo>();

    // 1. Add native Antigravity conversations
    const nativeSessions = loadNativeAntigravitySessions(cwd);
    const nativeByConvId = new Map<string, SessionInfo>();
    for (const n of nativeSessions) {
      nativeByConvId.set(n.sessionId, n);
      sessionMap.set(n.sessionId, n);
    }

    // 2. Add persisted ACP sessions
    const persisted = this.store.list(cwd);
    for (const p of persisted) {
      const nativeMatch = p.conversationId ? nativeByConvId.get(p.conversationId) : undefined;
      const realTitle = p.title || nativeMatch?.title || (p.cwd ? path.basename(p.cwd) : "Antigravity Session");
      const realUpdatedAt = nativeMatch?.updatedAt || p.updatedAt;

      // If an ACP session wraps a native conversation, remove the raw native entry to prevent duplicates
      if (p.conversationId && sessionMap.has(p.conversationId)) {
        sessionMap.delete(p.conversationId);
      }

      sessionMap.set(p.sessionId, {
        sessionId: p.sessionId,
        cwd: p.cwd,
        title: realTitle,
        updatedAt: realUpdatedAt,
      });
    }

    // 3. Active in-memory sessions
    for (const active of this.sessions.values()) {
      if (cwd) {
        const targetCwd = path.resolve(cwd).toLowerCase();
        const activeCwd = path.resolve(active.cwd).toLowerCase();
        if (targetCwd !== activeCwd) continue;
      }
      const existing = sessionMap.get(active.id);
      sessionMap.set(active.id, {
        sessionId: active.id,
        cwd: active.cwd,
        title: active.title || existing?.title || (active.cwd ? path.basename(active.cwd) : "Antigravity Session"),
        updatedAt: active.lastActivity.toISOString(),
      });
    }

    const list = Array.from(sessionMap.values());
    list.sort((a, b) => {
      const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return timeB - timeA;
    });
    return list;
  }
}
