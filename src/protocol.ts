import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { saveBase64Image } from "./attachments.js";

const execFileAsync = promisify(execFile);

export interface AgyInitEvent {
  event: "init";
  conversation_id: string;
  init: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
    model?: string;
    [key: string]: unknown;
  };
}

export interface AgyStepUpdateEvent {
  event: "step_update";
  step_update: {
    conversation_id: string;
    step_index: number;
    state: "ACTIVE" | "DONE" | "ERROR";
    step_type: "user_input" | "agent_response" | "tool" | "thought" | string;
    text_delta?: string;
    duration_seconds?: number;
    tool_name?: string;
    tool_info?: {
      name: string;
      parameters?: Record<string, unknown>;
      output?: string;
      error?: {
        type?: string;
        message?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
    [key: string]: unknown;
  };
}

export interface AgyResultEvent {
  event: "result";
  result: {
    conversation_id: string;
    status: "SUCCESS" | "ERROR";
    response: string;
    error?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
    [key: string]: unknown;
  };
}

export type AgyIncomingEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

export interface AgyStreamInputUserMessage {
  event: "user";
  message: {
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type RequestId = string | number;

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: T;
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: "2.0";
  id: RequestId;
  result: T;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: RequestId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

// ACP wire methods use snake_case. The aliases retain the public method names
// accepted by the adapter before the hardening work so existing clients do not
// lose compatibility.
export const ACP_METHODS = {
  INITIALIZE: "initialize",
  SESSION_NEW: "session/new",
  SESSION_NEW_ALIAS: "newSession",
  SESSION_LOAD: "session/load",
  SESSION_LOAD_ALIAS: "loadSession",
  SESSION_RESUME: "session/resume",
  SESSION_RESUME_ALIAS: "unstable_resumeSession",
  SESSION_PROMPT: "session/prompt",
  SESSION_PROMPT_ALIAS: "prompt",
  SESSION_CANCEL: "session/cancel",
  SESSION_CANCEL_ALIAS: "cancel",
  SESSION_CLOSE: "session/close",
  SESSION_CLOSE_ALIAS: "unstable_closeSession",
  SESSION_SET_MODE: "session/set_mode",
  SESSION_SET_MODE_ALIAS: "setSessionMode",
  SESSION_SET_MODEL: "session/set_model",
  SESSION_SET_MODEL_ALIAS: "unstable_setSessionModel",
  SESSION_SET_CONFIG_OPTION: "session/set_config_option",
  SESSION_SET_CONFIG_OPTION_ALIAS: "setSessionConfigOption",
  SESSION_UPDATE: "session/update",
} as const;

export type ToolKind = "read" | "edit" | "execute" | "fetch" | "other";

export function mapToolNameToKind(toolName: string): ToolKind {
  const name = toolName.toLowerCase();
  if (
    name.includes("read") ||
    name.includes("view") ||
    name.includes("list") ||
    name.includes("grep") ||
    name.includes("find") ||
    name === "view_file" ||
    name === "list_dir"
  ) return "read";
  if (
    name.includes("write") ||
    name.includes("replace") ||
    name.includes("edit") ||
    name.includes("sed") ||
    name === "write_to_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content"
  ) return "edit";
  if (
    name.includes("command") ||
    name.includes("terminal") ||
    name.includes("execute") ||
    name === "run_command"
  ) return "execute";
  if (
    name.includes("search") ||
    name.includes("url") ||
    name.includes("browser") ||
    name === "search_web"
  ) return "fetch";
  return "other";
}

export function extractPromptText(promptInput: unknown): string {
  if (typeof promptInput === "string") {
    const trimmed = promptInput.trim();
    return trimmed || "Please continue.";
  }

  const textParts: string[] = [];
  const imagePaths: string[] = [];

  const processBlock = (block: unknown) => {
    if (!block) return;
    if (typeof block === "string") {
      if (block.trim()) textParts.push(block.trim());
      return;
    }
    if (typeof block !== "object") return;

    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      textParts.push(b.text.trim());
      return;
    }
    if (b.type === "image") {
      if (typeof b.uri === "string" && b.uri.startsWith("file://")) {
        try {
          imagePaths.push(fileURLToPath(b.uri));
        } catch {
          logger.warn("Ignoring invalid file:// image URI");
        }
      } else if (typeof b.path === "string" && b.path.trim()) {
        imagePaths.push(b.path.trim());
      } else if (typeof b.data === "string" && b.data.length > 0) {
        const mime = typeof b.mimeType === "string" ? b.mimeType : "image/png";
        const savedPath = saveBase64Image(b.data, mime);
        if (savedPath) imagePaths.push(savedPath);
      }
      return;
    }
    if (b.type === "resource_link" && typeof b.uri === "string") {
      textParts.push(`[Resource: ${b.uri}]`);
    } else if (typeof b.content === "string" && b.content.trim()) {
      textParts.push(b.content.trim());
    }
  };

  if (Array.isArray(promptInput)) {
    for (const item of promptInput) processBlock(item);
  } else {
    processBlock(promptInput);
  }

  const imageInstructions = imagePaths.map(
    (imgPath) =>
      `[Attached Image: ${imgPath}]\n(The user attached an image saved at "${imgPath}". Please inspect and view it using the \`view_file\` tool with AbsolutePath="${imgPath}".)`
  );

  if (textParts.length > 0) {
    if (imageInstructions.length > 0) {
      return `${textParts.join("\n\n")}\n\n${imageInstructions.join("\n\n")}`;
    }
    return textParts.join("\n\n");
  }
  if (imageInstructions.length > 0) {
    return `Please inspect and analyze the attached image(s) using the \`view_file\` tool.\n\n${imageInstructions.join("\n\n")}`;
  }
  return "Please continue.";
}

export interface ModelDefinition {
  modelId: string;
  name: string;
  description?: string;
  supportedEfforts: string[];
  contextWindowMaxTokens?: number;
}

export interface ModelPricing {
  inputCostPerM: number;
  outputCostPerM: number;
  cachedInputCostPerM: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gemini-3.8-flash": { inputCostPerM: 0.10, outputCostPerM: 0.40, cachedInputCostPerM: 0.025 },
  "gemini-3.7-flash": { inputCostPerM: 0.10, outputCostPerM: 0.40, cachedInputCostPerM: 0.025 },
  "gemini-3.6-flash": { inputCostPerM: 0.10, outputCostPerM: 0.40, cachedInputCostPerM: 0.025 },
  "gemini-3.1-pro": { inputCostPerM: 1.25, outputCostPerM: 5.00, cachedInputCostPerM: 0.3125 },
  "claude-sonnet-4-6": { inputCostPerM: 3.00, outputCostPerM: 15.00, cachedInputCostPerM: 0.30 },
  "claude-opus-4-6-thinking": { inputCostPerM: 15.00, outputCostPerM: 75.00, cachedInputCostPerM: 1.50 },
  "gpt-oss-120b": { inputCostPerM: 0.15, outputCostPerM: 0.60, cachedInputCostPerM: 0.0375 },
};

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.1-pro": 2_097_152,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6-thinking": 200_000,
  "gpt-oss-120b": 128_000,
};

export function getModelContextWindow(modelId?: string): number {
  if (!modelId) return 1_048_576;
  if (MODEL_CONTEXT_WINDOWS[modelId]) return MODEL_CONTEXT_WINDOWS[modelId];

  const lower = modelId.toLowerCase();
  if (lower.includes("pro")) return 2_097_152;
  if (lower.includes("claude")) return 200_000;
  if (lower.includes("gpt")) return 128_000;
  if (lower.includes("flash")) return 1_048_576;

  return 1_048_576;
}

export function getModelPricing(modelId?: string): ModelPricing | null {
  if (!modelId) return null;
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];

  const lower = modelId.toLowerCase();
  if (lower.includes("opus")) return MODEL_PRICING["claude-opus-4-6-thinking"];
  if (lower.includes("claude") || lower.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
  if (lower.includes("pro")) return MODEL_PRICING["gemini-3.1-pro"];
  if (lower.includes("flash")) return MODEL_PRICING["gemini-3.7-flash"];
  if (lower.includes("gpt")) return MODEL_PRICING["gpt-oss-120b"];

  return null;
}

// Keep costs at full JavaScript floating-point precision. Rounding happens
// only when values are serialized for the UI so micro-costs accumulate.
export function calculateUsageCostUsd(
  modelId: string = "gemini-3.7-flash",
  inputTokens: number = 0,
  outputTokens: number = 0,
  cachedInputTokens: number = 0
): number {
  const pricing = getModelPricing(modelId);
  if (!pricing) return 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPerM;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerM;
  const cachedCost = (cachedInputTokens / 1_000_000) * pricing.cachedInputCostPerM;
  return inputCost + outputCost + cachedCost;
}

export function roundUsageCostUsd(costUsd: number, decimals: number = 6): number {
  const factor = 10 ** decimals;
  return Math.round(costUsd * factor) / factor;
}

export interface QuotaWindow {
  id: string;
  label: string;
  usedPct: number;
  remainingPct: number;
  resetsAt: string | null;
  tone: "ok" | "warning" | "danger" | "default";
}

export function deriveUsageTone(usedPct: number): "ok" | "warning" | "danger" | "default" {
  if (usedPct >= 90) return "danger";
  if (usedPct >= 75) return "warning";
  return "ok";
}

export function parseAgyQuotaOutput(raw: string): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const lines = raw.split(/[\r\n]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("quota:")) continue;
    const parts = trimmed.split(/\t+|\s{2,}/).map((p) => p.trim());
    if (parts.length >= 3) {
      const scope = parts[0];
      const limitType = parts[1];
      const remainingMatch = parts[2].match(/(\d+)%/);
      const resetsAt = parts[3] || null;
      if (remainingMatch) {
        const remainingPct = parseInt(remainingMatch[1], 10);
        const usedPct = Math.max(0, Math.min(100, 100 - remainingPct));
        const isFiveHour = /five\s*hour/i.test(limitType);
        const isWeekly = /weekly/i.test(limitType);
        const isGemini = /gemini/i.test(scope);

        let id = isFiveHour ? "session" : isWeekly ? "weekly" : "quota";
        let label = isFiveHour ? "Session (5h)" : isWeekly ? "Weekly" : limitType;
        if (!isGemini) {
          id = `claude_${id}`;
          label = `Claude ${label}`;
        }

        windows.push({
          id,
          label,
          usedPct,
          remainingPct,
          resetsAt,
          tone: deriveUsageTone(usedPct),
        });
      }
    }
  }
  return windows;
}

export interface CreditsBalance {
  id: string;
  label: string;
  remaining: number;
  unit: "usd";
  tone: "ok" | "warning" | "danger" | "default";
}

export function parseAgyCreditsOutput(raw: string): CreditsBalance {
  const match = raw.match(/Remaining\s+credits\s+([\d.]+)/i);
  const remaining = match ? parseFloat(match[1]) : 0;
  return {
    id: "credits",
    label: "Credits",
    remaining,
    unit: "usd",
    tone: remaining > 0 ? "ok" : "default",
  };
}

export interface ProviderUsage {
  providerId: string;
  displayName: string;
  status: "available" | "unavailable";
  planLabel: string | null;
  windows: QuotaWindow[];
  balances: CreditsBalance[];
  details: Array<{ id: string; label: string; value: string }>;
  error: string | null;
}

let cachedProviderUsage: ProviderUsage | null = null;
let cachedProviderUsageBinaryPath: string | null = null;
let lastProviderUsageFetch = 0;
const PROVIDER_USAGE_CACHE_TTL_MS = 30_000;

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason || "unknown error");
}

function cacheProviderUsage(binaryPath: string, result: ProviderUsage, now: number): ProviderUsage {
  cachedProviderUsage = result;
  cachedProviderUsageBinaryPath = binaryPath;
  lastProviderUsageFetch = now;
  return result;
}

export async function fetchAntigravityUsage(
  binaryPath: string = "agy",
  force: boolean = false
): Promise<ProviderUsage> {
  const now = Date.now();
  if (
    !force &&
    cachedProviderUsage &&
    cachedProviderUsageBinaryPath === binaryPath &&
    now - lastProviderUsageFetch < PROVIDER_USAGE_CACHE_TTL_MS
  ) {
    return cachedProviderUsage;
  }

  try {
    const [usageResult, creditsResult] = await Promise.allSettled([
      execFileAsync(binaryPath, ["--print", "/usage"], {
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      }),
      execFileAsync(binaryPath, ["--print", "/credits"], {
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      }),
    ]);

    const balances: CreditsBalance[] = [];
    if (creditsResult.status === "fulfilled") {
      const creditsOutput = creditsResult.value.stdout || creditsResult.value.stderr || "";
      if (creditsOutput.trim()) balances.push(parseAgyCreditsOutput(creditsOutput));
    }

    // /usage is the primary provider-availability probe. allSettled never
    // throws for an exec failure, so rejected results must be handled here.
    if (usageResult.status === "rejected") {
      const error = `Unable to fetch Antigravity quota: ${errorMessage(usageResult.reason)}`;
      logger.warn("Failed to fetch Antigravity provider usage", { error });
      return cacheProviderUsage(binaryPath, {
        providerId: "antigravity",
        displayName: "Antigravity",
        status: "unavailable",
        planLabel: null,
        windows: [],
        balances,
        details: [],
        error,
      }, now);
    }

    const quotaOutput = usageResult.value.stdout || usageResult.value.stderr || "";
    const windows = parseAgyQuotaOutput(quotaOutput);
    const partialError = creditsResult.status === "rejected"
      ? `Credits unavailable: ${errorMessage(creditsResult.reason)}`
      : null;

    return cacheProviderUsage(binaryPath, {
      providerId: "antigravity",
      displayName: "Antigravity",
      status: "available",
      planLabel: "Google Gemini",
      windows,
      balances,
      details: [],
      error: partialError,
    }, now);
  } catch (err) {
    const error = errorMessage(err);
    logger.warn("Failed to fetch Antigravity provider usage", { error });
    return cacheProviderUsage(binaryPath, {
      providerId: "antigravity",
      displayName: "Antigravity",
      status: "unavailable",
      planLabel: null,
      windows: [],
      balances: [],
      details: [],
      error,
    }, now);
  }
}

export const ALL_THINKING_LEVELS: Record<string, { name: string; description: string }> = {
  low: { name: "Low", description: "Fast response with minimal reasoning latency" },
  medium: { name: "Medium", description: "Balanced reasoning effort and speed" },
  high: { name: "High", description: "Deep reasoning effort for complex tasks" },
};

export const FALLBACK_MODELS: ModelDefinition[] = [
  { modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Google Gemini 3.8 Flash", supportedEfforts: ["high", "medium", "low"], contextWindowMaxTokens: 1_048_576 },
  { modelId: "gemini-3.7-flash", name: "Gemini 3.7 Flash", description: "Google Gemini 3.7 Flash", supportedEfforts: ["high", "medium", "low"], contextWindowMaxTokens: 1_048_576 },
  { modelId: "gemini-3.6-flash", name: "Gemini 3.6 Flash", description: "Google Gemini 3.6 Flash", supportedEfforts: ["high", "medium", "low"], contextWindowMaxTokens: 1_048_576 },
  { modelId: "gemini-3.1-pro", name: "Gemini 3.1 Pro", description: "Google Gemini 3.1 Pro", supportedEfforts: ["high", "low"], contextWindowMaxTokens: 2_097_152 },
  { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", description: "Anthropic Claude Sonnet 4.6 (Thinking)", supportedEfforts: [], contextWindowMaxTokens: 200_000 },
  { modelId: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", description: "Anthropic Claude Opus 4.6 (Thinking)", supportedEfforts: [], contextWindowMaxTokens: 200_000 },
  { modelId: "gpt-oss-120b", name: "GPT-OSS 120B", description: "GPT-OSS 120B (Medium)", supportedEfforts: ["medium"], contextWindowMaxTokens: 128_000 },
];

let cachedModels: ModelDefinition[] | null = null;
let cachedModelsBinaryPath: string | null = null;
let lastModelFetch = 0;
const MODEL_CACHE_TTL_MS = 60_000;

export function parseAgyModelsOutput(rawOutput: string): ModelDefinition[] {
  const modelsMap = new Map<string, ModelDefinition>();
  for (const line of rawOutput.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("Fetching available models")) continue;
    const parts = trimmed.split(/\t+|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const modelId = parts[0];
    const label = parts[1];
    const effortMatch = modelId.match(/-(high|medium|low)$/);
    let baseId = modelId;
    let baseLabel = label;
    let effort: string | null = null;
    if (effortMatch) {
      effort = effortMatch[1];
      baseId = modelId.slice(0, -(effort.length + 1));
      baseLabel = label.replace(/\s*\((High|Medium|Low)\)$/, "");
    }
    if (!modelsMap.has(baseId)) {
      modelsMap.set(baseId, {
        modelId: baseId,
        name: baseLabel,
        description: label,
        supportedEfforts: [],
        contextWindowMaxTokens: getModelContextWindow(baseId),
      });
    }
    if (effort) {
      const entry = modelsMap.get(baseId)!;
      if (!entry.supportedEfforts.includes(effort)) entry.supportedEfforts.push(effort);
    }
  }
  const result = Array.from(modelsMap.values());
  return result.length > 0 ? result : FALLBACK_MODELS;
}

export async function fetchAvailableModels(binaryPath: string = "agy", force = false): Promise<ModelDefinition[]> {
  const now = Date.now();
  if (
    !force &&
    cachedModels &&
    cachedModelsBinaryPath === binaryPath &&
    now - lastModelFetch < MODEL_CACHE_TTL_MS
  ) {
    return cachedModels;
  }
  try {
    const { stdout } = await execFileAsync(binaryPath, ["models"], {
      timeout: 5_000,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = parseAgyModelsOutput(stdout);
    cachedModels = parsed;
    cachedModelsBinaryPath = binaryPath;
    lastModelFetch = now;
    return parsed;
  } catch (err) {
    logger.warn("Failed to fetch models from agy CLI, using fallback models", {
      error: (err as Error).message,
    });
    cachedModels = FALLBACK_MODELS;
    cachedModelsBinaryPath = binaryPath;
    lastModelFetch = now;
    return FALLBACK_MODELS;
  }
}

export function getEffectiveEffortForModel(
  modelId?: string,
  requestedEffort?: string,
  models?: ModelDefinition[]
): string | undefined {
  if (!modelId) return undefined;
  const modelList = models || cachedModels || FALLBACK_MODELS;
  const modelDef = modelList.find((m) => m.modelId === modelId);
  if (!modelDef || modelDef.supportedEfforts.length === 0) return undefined;
  if (requestedEffort && modelDef.supportedEfforts.includes(requestedEffort)) return requestedEffort;
  if (modelDef.supportedEfforts.includes("high")) return "high";
  return modelDef.supportedEfforts[0];
}

export const AVAILABLE_MODES = [
  { id: "default", name: "Default (Accept Edits)", description: "Standard autonomous execution and coding mode" },
  { id: "plan", name: "Plan Mode", description: "Planning and read-only analysis without file modifications" },
];

export function buildConfigOptionsForModel(
  modelId: string,
  currentEffort = "high",
  availableModels?: ModelDefinition[]
) {
  const modelList = availableModels || cachedModels || FALLBACK_MODELS;
  const modelDef = modelList.find((m) => m.modelId === modelId);
  const supported = modelDef ? modelDef.supportedEfforts : ["high", "medium", "low"];
  if (!supported || supported.length === 0) return [];
  const effectiveEffort = supported.includes(currentEffort)
    ? currentEffort
    : supported.includes("high")
      ? "high"
      : supported[0];
  const options = supported.map((effortId) => ({
    value: effortId,
    name: ALL_THINKING_LEVELS[effortId]?.name || effortId.toUpperCase(),
    description: ALL_THINKING_LEVELS[effortId]?.description || `${effortId} effort`,
  }));
  return [
    {
      id: "thought_level",
      name: "Thinking Effort",
      category: "thought_level",
      type: "select" as const,
      currentValue: effectiveEffort,
      options,
    },
  ];
}
