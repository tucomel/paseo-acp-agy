import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  CreditsBalanceItem,
  QuotaReport,
  QuotaWindowItem,
  SessionTelemetry,
  UsageTone,
} from "../shared/telemetry.ts";

const execFileAsync = promisify(execFile);

let cachedAgyBin: string | null = null;
let cachedAgyBinAt = 0;
const BIN_CACHE_TTL_MS = 60_000;

let cachedQuota: QuotaReport | null = null;
let cachedQuotaAt = 0;
const QUOTA_CACHE_TTL_MS = 60_000;
let inflightQuotaPromise: Promise<QuotaReport> | null = null;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-4-argon": 1_048_576,
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.1-pro": 2_097_152,
  "claude-opus-5-5": 200_000,
  "claude-sonnet-5-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6-thinking": 200_000,
  "gpt-oss-120b": 128_000,
};

const MODEL_PRICING: Record<
  string,
  { inputCostPerM: number; outputCostPerM: number; cachedInputCostPerM: number }
> = {
  "gemini-4-argon": { inputCostPerM: 1.25, outputCostPerM: 5.0, cachedInputCostPerM: 0.3125 },
  "gemini-3.8-flash": { inputCostPerM: 0.1, outputCostPerM: 0.4, cachedInputCostPerM: 0.025 },
  "gemini-3.7-flash": { inputCostPerM: 0.1, outputCostPerM: 0.4, cachedInputCostPerM: 0.025 },
  "gemini-3.6-flash": { inputCostPerM: 0.1, outputCostPerM: 0.4, cachedInputCostPerM: 0.025 },
  "gemini-3.1-pro": { inputCostPerM: 1.25, outputCostPerM: 5.0, cachedInputCostPerM: 0.3125 },
  "claude-opus-5-5": { inputCostPerM: 15.0, outputCostPerM: 75.0, cachedInputCostPerM: 1.5 },
  "claude-sonnet-5-5": { inputCostPerM: 3.0, outputCostPerM: 15.0, cachedInputCostPerM: 0.3 },
  "claude-sonnet-4-6": { inputCostPerM: 3.0, outputCostPerM: 15.0, cachedInputCostPerM: 0.3 },
  "claude-opus-4-6-thinking": { inputCostPerM: 15.0, outputCostPerM: 75.0, cachedInputCostPerM: 1.5 },
  "gpt-oss-120b": { inputCostPerM: 0.15, outputCostPerM: 0.6, cachedInputCostPerM: 0.0375 },
};

export function getModelContextWindow(modelId?: string | null): number {
  if (!modelId) return 1_048_576;
  const clean = modelId.replace(/^antigravity\//i, "").replace(/-(high|medium|low)$/i, "");
  if (MODEL_CONTEXT_WINDOWS[clean]) return MODEL_CONTEXT_WINDOWS[clean];
  const lower = clean.toLowerCase();
  if (lower.includes("argon")) return 1_048_576;
  if (lower.includes("pro")) return 2_097_152;
  if (lower.includes("claude")) return 200_000;
  if (lower.includes("gpt")) return 128_000;
  return 1_048_576;
}

function estimateCostUsd(
  modelId: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number
): number {
  if (!modelId) return 0;
  const clean = modelId.replace(/^antigravity\//i, "").replace(/-(high|medium|low)$/i, "");
  let pricing = MODEL_PRICING[clean] ?? null;
  if (!pricing) {
    const lower = clean.toLowerCase();
    if (lower.includes("argon")) pricing = MODEL_PRICING["gemini-4-argon"];
    else if (lower.includes("opus")) pricing = MODEL_PRICING["claude-opus-4-6-thinking"];
    else if (lower.includes("claude") || lower.includes("sonnet")) pricing = MODEL_PRICING["claude-sonnet-4-6"];
    else if (lower.includes("pro")) pricing = MODEL_PRICING["gemini-3.1-pro"];
    else if (lower.includes("flash")) pricing = MODEL_PRICING["gemini-3.8-flash"];
    else if (lower.includes("gpt-oss")) pricing = MODEL_PRICING["gpt-oss-120b"];
  }
  if (!pricing) return 0;
  const cost =
    (inputTokens / 1_000_000) * pricing.inputCostPerM +
    (outputTokens / 1_000_000) * pricing.outputCostPerM +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputCostPerM;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function deriveTone(usedPct: number): UsageTone {
  if (usedPct >= 90) return "danger";
  if (usedPct >= 75) return "warning";
  return "ok";
}

function normalizeResetTimestamp(rawReset: string | undefined | null): string | null {
  if (!rawReset) return null;
  const trimmed = rawReset.trim();
  if (!trimmed) return null;
  const normalizedUtc = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+UTC$/i, "$1T$2Z");
  const parsed = Date.parse(normalizedUtc);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  const durMatch = trimmed.match(/(?:(\d+)h)?\s*(?:(\d+)m)?/i);
  if (durMatch && (durMatch[1] || durMatch[2])) {
    const hours = parseInt(durMatch[1] || "0", 10);
    const mins = parseInt(durMatch[2] || "0", 10);
    return new Date(Date.now() + (hours * 3600 + mins * 60) * 1000).toISOString();
  }
  return null;
}

export function resolveAgyBinary(): string {
  const now = Date.now();
  if (cachedAgyBin && now - cachedAgyBinAt < BIN_CACHE_TTL_MS) {
    return cachedAgyBin;
  }

  if (process.env.AGY_BIN_PATH && fs.existsSync(process.env.AGY_BIN_PATH)) {
    cachedAgyBin = process.env.AGY_BIN_PATH;
    cachedAgyBinAt = now;
    return cachedAgyBin;
  }

  const home = os.homedir();
  const isWin = process.platform === "win32";

  if (isWin) {
    const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
    const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    const winCandidates = [
      path.join(localAppData, "agy", "bin", "agy.exe"),
      path.join(localAppData, "Programs", "Antigravity", "bin", "agy.exe"),
      path.join(localAppData, "Programs", "Antigravity", "agy.exe"),
      path.join(programFiles, "Antigravity", "bin", "agy.exe"),
      path.join(programFilesX86, "Antigravity", "bin", "agy.exe"),
      path.join(localAppData, "Microsoft", "WindowsApps", "agy.exe"),
      path.join(home, ".local", "bin", "agy.exe"),
      path.join(appData, "npm", "agy.cmd"),
      path.join(localAppData, "npm", "agy.cmd"),
    ];
    for (const cand of winCandidates) {
      if (cand && fs.existsSync(cand)) {
        cachedAgyBin = cand;
        cachedAgyBinAt = now;
        return cand;
      }
    }
    try {
      const out = execFileSync("where.exe", ["agy"], {
        encoding: "utf-8",
        timeout: 2500,
        windowsHide: true,
      });
      const first = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => Boolean(l) && fs.existsSync(l));
      if (first) {
        cachedAgyBin = first;
        cachedAgyBinAt = now;
        return first;
      }
    } catch {}
    cachedAgyBin = "agy.exe";
    cachedAgyBinAt = now;
    return cachedAgyBin;
  }

  const posixCandidates = [
    home ? path.join(home, ".local", "bin", "agy") : "",
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "/usr/bin/agy",
    home ? path.join(home, ".antigravity", "bin", "agy") : "",
    home ? path.join(home, ".gemini", "antigravity-cli", "bin", "agy") : "",
  ].filter(Boolean);

  for (const cand of posixCandidates) {
    if (fs.existsSync(cand)) {
      cachedAgyBin = cand;
      cachedAgyBinAt = now;
      return cand;
    }
  }

  try {
    const out = execFileSync("which", ["agy"], { encoding: "utf-8", timeout: 2500 }).trim();
    if (out && fs.existsSync(out)) {
      cachedAgyBin = out;
      cachedAgyBinAt = now;
      return out;
    }
  } catch {}

  cachedAgyBin = "agy";
  cachedAgyBinAt = now;
  return cachedAgyBin;
}

function buildExecEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const env: NodeJS.ProcessEnv = { ...process.env };
  const extraPaths = isWin
    ? [
        home ? path.join(home, ".local", "bin") : "",
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity", "bin") : "",
      ].filter((p) => p && fs.existsSync(p))
    : [
        home ? path.join(home, ".local", "bin") : "",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        home ? path.join(home, ".antigravity", "bin") : "",
        home ? path.join(home, ".gemini", "antigravity-cli", "bin") : "",
      ].filter((p) => p && fs.existsSync(p));

  if (extraPaths.length > 0) {
    const sep = path.delimiter;
    const current = env.PATH || env.Path || "";
    const merged = (current ? current + sep : "") + extraPaths.join(sep);
    env.PATH = merged;
    if (isWin) env.Path = merged;
  }
  return env;
}

export async function fetchAntigravityQuota(force = false): Promise<QuotaReport> {
  const now = Date.now();
  if (!force && cachedQuota && now - cachedQuotaAt < QUOTA_CACHE_TTL_MS) {
    return cachedQuota;
  }
  if (!force && inflightQuotaPromise) {
    return inflightQuotaPromise;
  }

  inflightQuotaPromise = (async (): Promise<QuotaReport> => {
    try {
      const bin = resolveAgyBinary();
      const isWin = process.platform === "win32";
      const isBatch = isWin && /\.(cmd|bat)$/i.test(bin);
      const env = buildExecEnv();

      let usageOut = "";
      try {
        const res = await execFileAsync(bin, ["--print-timeout", "24h", "--print", "/usage"], {
          timeout: 25_000,
          env,
          shell: isBatch,
          windowsHide: true,
        });
        usageOut = res.stdout || res.stderr || "";
      } catch (err) {
        if (cachedQuota && !force) return cachedQuota;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "unavailable",
          planLabel: "Google Gemini",
          windows: [],
          balances: [],
          error: `Unable to query agy /usage: ${msg}`,
          fetchedAt: new Date().toISOString(),
        };
      }

      let creditsOut = "";
      try {
        const credRes = await execFileAsync(bin, ["--print-timeout", "24h", "--print", "/credits"], {
          timeout: 6_000,
          env,
          shell: isBatch,
          windowsHide: true,
        });
        creditsOut = credRes.stdout || credRes.stderr || "";
      } catch {}

      const rawWindows: Array<
        QuotaWindowItem & { isFiveHour: boolean; isGemini: boolean; isArgon: boolean }
      > = [];
      let currentScope = "";

      for (const rawLine of usageOut.replace(/\r\n/g, "\n").split("\n")) {
        const line = rawLine.trim();
        if (!line || line.toLowerCase().startsWith("quota:")) continue;

        let scope = currentScope;
        let limitType = "";
        let remainingPct: number | null = null;
        let resetsAt: string | null = null;

        const tableMatch = line.match(/^(.*?)\s{2,}(.*?)\s+(\d+)%(?:\s+(.*))?$/i);
        if (tableMatch) {
          scope = tableMatch[1].trim();
          limitType = tableMatch[2].trim();
          remainingPct = parseInt(tableMatch[3], 10);
          resetsAt = normalizeResetTimestamp(tableMatch[4]);
        } else {
          const parts = line.split(/\t+|\s{2,}/).map((p) => p.trim());
          if (parts.length >= 3) {
            scope = parts[0];
            limitType = parts[1];
            const rem = parts[2].match(/(\d+)%/);
            if (rem) remainingPct = parseInt(rem[1], 10);
            resetsAt = normalizeResetTimestamp(parts[3]);
          } else if (line.endsWith(":") && !line.includes("%")) {
            currentScope = line.slice(0, -1).trim();
            continue;
          }
        }

        if (remainingPct !== null && !Number.isNaN(remainingPct)) {
          const clampedRemaining = Math.max(0, Math.min(100, remainingPct));
          const usedPct = Math.max(0, Math.min(100, 100 - clampedRemaining));
          const isFiveHour = /session|five\s*hour|5-?hour|5h/i.test(limitType);
          const isWeekly = /week|7-?day/i.test(limitType);
          const isArgon = /argon/i.test(scope) || /argon/i.test(limitType);
          const isClaude = /claude|gpt/i.test(scope);
          const isGemini = (/gemini/i.test(scope) || !isClaude) && !isArgon;

          let id = isFiveHour ? "session" : isWeekly ? "weekly" : "quota";
          let label = isFiveHour
            ? "Gemini Session (5h)"
            : isWeekly
              ? "Gemini Weekly"
              : limitType.replace(/\s+Remaining$/i, "");
          let shortLabel = isFiveHour ? "5h" : isWeekly ? "wk" : "";

          if (isArgon) {
            id = `argon_${id}`;
            label = `Gemini 4 Argon ${isFiveHour ? "Session (5h)" : isWeekly ? "Weekly" : "Limit"}`;
            shortLabel = "Argon";
          } else if (!isGemini) {
            id = `claude_${id}`;
            label = `Claude/GPT ${isFiveHour ? "Session (5h)" : isWeekly ? "Weekly" : limitType}`;
            shortLabel = isFiveHour ? "Claude 5h" : "Claude wk";
          }

          rawWindows.push({
            id,
            label,
            shortLabel,
            summary: isGemini && !isArgon,
            usedPct,
            remainingPct: clampedRemaining,
            resetsAt,
            tone: deriveTone(usedPct),
            isFiveHour,
            isGemini,
            isArgon,
          });
        }
      }

      rawWindows.sort((a, b) => {
        const rank = (w: typeof a) => {
          if (w.isGemini && !w.isArgon) return w.isFiveHour ? 1 : 2;
          if (w.isArgon) return w.isFiveHour ? 3 : 4;
          return w.isFiveHour ? 5 : 6;
        };
        return rank(a) - rank(b);
      });

      if (rawWindows.length > 0 && !rawWindows.some((w) => w.summary)) {
        rawWindows[0].summary = true;
      }

      const windows: QuotaWindowItem[] = rawWindows.map(
        ({ isFiveHour: _f, isGemini: _g, isArgon: _a, ...rest }) => rest
      );

      const balances: CreditsBalanceItem[] = [];
      const credMatch = creditsOut.match(/Remaining\s+credits\s+([\d.]+)/i);
      const remainingCredits = credMatch ? parseFloat(credMatch[1]) : 0;
      balances.push({
        id: "credits",
        label: "Credits",
        remaining: Number.isFinite(remainingCredits) ? remainingCredits : 0,
        unit: "usd",
        tone: remainingCredits > 0 ? "ok" : "default",
      });

      const report: QuotaReport = {
        status: "available",
        planLabel: "Google Gemini",
        windows,
        balances,
        error: null,
        fetchedAt: new Date().toISOString(),
      };
      cachedQuota = report;
      cachedQuotaAt = Date.now();
      return report;
    } catch (err) {
      if (cachedQuota && !force) return cachedQuota;
      return {
        status: "error",
        planLabel: "Google Gemini",
        windows: [],
        balances: [],
        error: err instanceof Error ? err.message : String(err),
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      inflightQuotaPromise = null;
    }
  })();

  return inflightQuotaPromise;
}

interface PersistedAcpSessionFile {
  sessionId?: string;
  conversationId?: string;
  model?: string;
  effort?: string;
  updatedAt?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    totalCostUsd?: number;
    contextWindowUsedTokens?: number;
    contextWindowMaxTokens?: number;
  };
}

function getAcpSessionsDir(): string {
  if (process.env.AGY_ACP_STATE_DIR) {
    return path.join(process.env.AGY_ACP_STATE_DIR, "sessions");
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "agy-acp", "sessions");
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "agy-acp", "sessions");
}

function loadPersistedAcpSession(sessionId: string | null): PersistedAcpSessionFile | null {
  if (!sessionId) return null;
  try {
    const fileHash = crypto.createHash("sha256").update(sessionId).digest("hex");
    const filePath = path.join(getAcpSessionsDir(), `${fileHash}.json`);
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PersistedAcpSessionFile;
    if (parsed.sessionId && parsed.sessionId !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface AgentSnapshotInfo {
  id: string;
  model?: string | null;
  updatedAt?: string | null;
  activeTurn?: unknown;
  persistence?: { sessionId?: string | null } | null;
  runtimeInfo?: { sessionId?: string | null } | null;
  lastUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalCostUsd?: number;
    contextWindowUsedTokens?: number;
    contextWindowMaxTokens?: number;
  } | null;
}

function estimateConversationContextTokens(conversationId: string | null | undefined, maxTokens: number): number | null {
  if (!conversationId) return null;
  const home = os.homedir();
  const candidates = [
    process.env.AGY_BRAIN_DIR ? path.join(process.env.AGY_BRAIN_DIR, conversationId) : "",
    home ? path.join(home, ".gemini", "antigravity-cli", "brain", conversationId) : "",
    home ? path.join(home, ".antigravity", "brain", conversationId) : "",
  ].filter(Boolean);

  for (const brainDir of candidates) {
    const transcriptPath = path.join(brainDir, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(transcriptPath)) continue;
    try {
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      let activeChars = 0;
      for (const line of lines) {
        try {
          const step = JSON.parse(line) as Record<string, unknown>;
          const rawContent = typeof step.content === "string" ? step.content : "";
          if (step.type === "USER_INPUT" && rawContent.includes("<CONTEXT_SUMMARY>")) {
            activeChars = 0;
          }
          activeChars += rawContent.length;
          if (typeof step.thinking === "string") activeChars += step.thinking.length;
          if (Array.isArray(step.tool_calls)) activeChars += JSON.stringify(step.tool_calls).length;
        } catch {}
      }
      if (activeChars <= 0) return null;
      return Math.min(maxTokens, 4_000 + Math.ceil(activeChars / 4));
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveSessionTelemetry(
  agentId: string,
  snapshot: AgentSnapshotInfo | null | undefined
): SessionTelemetry {
  const sessionId = snapshot?.persistence?.sessionId ?? snapshot?.runtimeInfo?.sessionId ?? null;
  const persisted = loadPersistedAcpSession(sessionId);
  const model = snapshot?.model ?? persisted?.model ?? "gemini-3.8-flash";
  const defaultMax = getModelContextWindow(model);

  if (persisted?.usage) {
    const u = persisted.usage;
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const cachedInputTokens = u.cachedInputTokens ?? 0;
    const totalTokens = u.totalTokens ?? inputTokens + outputTokens;
    const maxTokens =
      typeof u.contextWindowMaxTokens === "number" && u.contextWindowMaxTokens > 0
        ? u.contextWindowMaxTokens
        : defaultMax;
    // Prefer live streaming contextWindowUsedTokens from snapshot if higher/fresher mid-turn
    const liveUsed = snapshot?.lastUsage?.contextWindowUsedTokens;
    let rawUsed =
      snapshot?.activeTurn && typeof liveUsed === "number" && liveUsed > 0
        ? liveUsed
        : (u.contextWindowUsedTokens ?? liveUsed ?? 0);
    // Repair legacy pre-v1.3.0 sessions where cumulative inputTokens was clamped to maxTokens
    if (
      rawUsed >= maxTokens &&
      inputTokens > maxTokens &&
      (!liveUsed || liveUsed >= maxTokens) &&
      persisted.conversationId
    ) {
      const estimated = estimateConversationContextTokens(persisted.conversationId, maxTokens);
      if (estimated !== null && estimated > 0 && estimated < maxTokens) {
        rawUsed = estimated;
      }
    }
    const usedTokens = Math.min(Math.max(0, rawUsed), maxTokens);
    const totalCostUsd =
      typeof u.totalCostUsd === "number"
        ? Math.round(u.totalCostUsd * 1_000_000) / 1_000_000
        : estimateCostUsd(model, inputTokens, outputTokens, cachedInputTokens);

    return {
      agentId,
      sessionId,
      conversationId: persisted.conversationId ?? null,
      model,
      effort: persisted.effort ?? null,
      activeTurn: Boolean(snapshot?.activeTurn),
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens,
      totalCostUsd,
      contextWindowUsedTokens: usedTokens,
      contextWindowMaxTokens: maxTokens,
      contextPct: maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 1000) / 10) : 0,
      updatedAt: persisted.updatedAt ?? snapshot?.updatedAt ?? null,
      source: "acp_store",
    };
  }

  if (snapshot?.lastUsage) {
    const lu = snapshot.lastUsage;
    const inputTokens = lu.inputTokens ?? 0;
    const outputTokens = lu.outputTokens ?? 0;
    const cachedInputTokens = lu.cachedInputTokens ?? 0;
    const totalTokens = inputTokens + outputTokens;
    const maxTokens =
      typeof lu.contextWindowMaxTokens === "number" && lu.contextWindowMaxTokens > 0
        ? lu.contextWindowMaxTokens
        : defaultMax;
    const usedTokens = Math.min(Math.max(0, lu.contextWindowUsedTokens ?? 0), maxTokens);
    const totalCostUsd =
      typeof lu.totalCostUsd === "number"
        ? Math.round(lu.totalCostUsd * 1_000_000) / 1_000_000
        : estimateCostUsd(model, inputTokens, outputTokens, cachedInputTokens);

    return {
      agentId,
      sessionId,
      conversationId: persisted?.conversationId ?? null,
      model,
      effort: persisted?.effort ?? null,
      activeTurn: Boolean(snapshot.activeTurn),
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens,
      totalCostUsd,
      contextWindowUsedTokens: usedTokens,
      contextWindowMaxTokens: maxTokens,
      contextPct: maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 1000) / 10) : 0,
      updatedAt: snapshot.updatedAt ?? null,
      source: "agent_snapshot",
    };
  }

  if (persisted?.conversationId) {
    const estimated = estimateConversationContextTokens(persisted.conversationId, defaultMax) ?? 0;
    return {
      agentId,
      sessionId,
      conversationId: persisted.conversationId,
      model,
      effort: persisted.effort ?? null,
      activeTurn: Boolean(snapshot?.activeTurn),
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      contextWindowUsedTokens: estimated,
      contextWindowMaxTokens: defaultMax,
      contextPct: defaultMax > 0 ? Math.min(100, Math.round((estimated / defaultMax) * 1000) / 10) : 0,
      updatedAt: persisted.updatedAt ?? snapshot?.updatedAt ?? null,
      source: "acp_store",
    };
  }

  return {
    agentId,
    sessionId,
    conversationId: null,
    model,
    effort: null,
    activeTurn: Boolean(snapshot?.activeTurn),
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    contextWindowUsedTokens: 0,
    contextWindowMaxTokens: defaultMax,
    contextPct: 0,
    updatedAt: snapshot?.updatedAt ?? null,
    source: "default",
  };
}

export function createAntigravityUsageSource() {
  return {
    id: "antigravity-acp",
    label: "Antigravity",
    icon: "icon.svg",
    input: z.object({}).passthrough(),
    discover: async (scope?: { kind?: string; provider?: string }) => {
      if (
        scope &&
        scope.kind === "session" &&
        scope.provider &&
        scope.provider !== "antigravity" &&
        scope.provider !== "acp" &&
        !scope.provider.startsWith("antigravity/")
      ) {
        return [];
      }
      return [{ key: "default", label: "Antigravity", input: {} }];
    },
    fetch: async () => {
      const report = await fetchAntigravityQuota(false);
      if (report.status === "available") {
        return {
          status: "available" as const,
          planLabel: report.planLabel ?? "Google Gemini",
          windows: report.windows,
          balances: report.balances,
          details: [],
        };
      }
      return {
        status: "error" as const,
        error: report.error ?? "Unable to fetch Antigravity quota",
      };
    },
  };
}
