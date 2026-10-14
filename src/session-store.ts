import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { logger } from "./logger.js";

export interface SessionUsageState {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  contextWindowUsedTokens: number;
  contextWindowMaxTokens: number;
}

export interface PersistedSessionState {
  sessionId: string;
  conversationId?: string;
  cwd: string;
  title?: string;
  model: string;
  effort: string;
  mode: string;
  permission?: string;
  usage?: SessionUsageState;
  updatedAt: string;
}

function getStateRoot(): string {
  if (process.env.AGY_ACP_STATE_DIR) {
    return process.env.AGY_ACP_STATE_DIR;
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "agy-acp");
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "agy-acp");
}

function fileNameForSession(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex") + ".json";
}

export class SessionStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir || path.join(getStateRoot(), "sessions");
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        fs.chmodSync(this.dir, 0o700);
      }
    } catch {}
  }

  get storageDir(): string {
    return this.dir;
  }

  private pathFor(sessionId: string): string {
    return path.join(this.dir, fileNameForSession(sessionId));
  }

  load(sessionId: string): PersistedSessionState | null {
    const filePath = this.pathFor(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PersistedSessionState;
      if (parsed.sessionId !== sessionId) {
        logger.warn("Ignoring persisted session with mismatched session ID", { sessionId });
        return null;
      }
      return parsed;
    } catch (err) {
      logger.warn("Failed to load persisted ACP session", {
        sessionId,
        error: (err as Error).message,
      });
      return null;
    }
  }

  save(state: PersistedSessionState): void {
    const filePath = this.pathFor(state.sessionId);
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (process.platform === "win32" && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tempPath, filePath);
      if (process.platform !== "win32") {
        fs.chmodSync(filePath, 0o600);
      }
    } catch (err) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      logger.warn("Failed to persist ACP session state", {
        sessionId: state.sessionId,
        error: (err as Error).message,
      });
    }
  }

  delete(sessionId: string): boolean {
    const filePath = this.pathFor(sessionId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch (err) {
      logger.warn("Failed to delete persisted ACP session", {
        sessionId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  list(cwd?: string): PersistedSessionState[] {
    if (!fs.existsSync(this.dir)) return [];
    const results: PersistedSessionState[] = [];
    const normalizedTargetCwd = cwd ? path.resolve(cwd).toLowerCase() : undefined;

    try {
      const files = fs.readdirSync(this.dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const fullPath = path.join(this.dir, file);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const parsed = JSON.parse(content) as PersistedSessionState;
          if (!parsed.sessionId) continue;

          // Skip untitled placeholder sessions that have neither conversationId nor any recorded usage
          const hasTitle = Boolean(parsed.title && parsed.title.trim());
          const hasConv = Boolean(parsed.conversationId);
          const hasUsage = Boolean(
            parsed.usage && (parsed.usage.totalTokens > 0 || parsed.usage.inputTokens > 0)
          );
          if (!hasTitle && !hasConv && !hasUsage) {
            continue;
          }

          if (normalizedTargetCwd && parsed.cwd) {
            const sessionCwd = path.resolve(parsed.cwd).toLowerCase();
            if (sessionCwd !== normalizedTargetCwd) continue;
          }
          results.push(parsed);
        } catch {
          // ignore corrupted individual files
        }
      }

      // Sort by updatedAt descending
      results.sort((a, b) => {
        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return timeB - timeA;
      });
    } catch (err) {
      logger.warn("Failed to list persisted ACP sessions", { error: (err as Error).message });
    }

    return results;
  }
}

export const sessionStore = new SessionStore();
