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
  model: string;
  effort: string;
  mode: string;
  usage?: SessionUsageState;
  updatedAt: string;
}

function getStateRoot(): string {
  if (process.env.AGY_ACP_STATE_DIR) {
    return process.env.AGY_ACP_STATE_DIR;
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
}

export const sessionStore = new SessionStore();
