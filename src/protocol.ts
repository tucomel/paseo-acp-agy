import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

// ACP (JSON-RPC 2.0) & Antigravity stream-json protocol types

// ---------------------------------------------------------------------------
// Antigravity stream-json Protocol Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ACP (JSON-RPC 2.0) Types
// ---------------------------------------------------------------------------

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

// ACP Methods
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
  ) {
    return "read";
  }
  if (
    name.includes("write") ||
    name.includes("replace") ||
    name.includes("edit") ||
    name.includes("sed") ||
    name === "write_to_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content"
  ) {
    return "edit";
  }
  if (name.includes("command") || name.includes("terminal") || name.includes("execute") || name === "run_command") {
    return "execute";
  }
  if (name.includes("search") || name.includes("url") || name.includes("browser") || name === "search_web") {
    return "fetch";
  }
  return "other";
}

export function extractPromptText(promptInput: unknown): string {
  if (typeof promptInput === "string") {
    return promptInput;
  }
  if (Array.isArray(promptInput)) {
    const parts: string[] = [];
    for (const item of promptInput) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        if ("text" in item && typeof item.text === "string") {
          parts.push(item.text);
        } else if ("content" in item && typeof item.content === "string") {
          parts.push(item.content);
        }
      }
    }
    return parts.join("\n");
  }
  if (promptInput && typeof promptInput === "object") {
    if ("text" in promptInput && typeof (promptInput as { text: unknown }).text === "string") {
      return (promptInput as { text: string }).text;
    }
    if ("content" in promptInput && typeof (promptInput as { content: unknown }).content === "string") {
      return (promptInput as { content: string }).content;
    }
  }
  return String(promptInput ?? "");
}

export interface ModelDefinition {
  modelId: string;
  name: string;
  description?: string;
  supportedEfforts: string[];
}

export const ALL_THINKING_LEVELS: Record<string, { name: string; description: string }> = {
  low: {
    name: "Low",
    description: "Fast response with minimal reasoning latency",
  },
  medium: {
    name: "Medium",
    description: "Balanced reasoning effort and speed",
  },
  high: {
    name: "High",
    description: "Deep reasoning effort for complex tasks",
  },
};

// Fallback models in case agy models command fails
export const FALLBACK_MODELS: ModelDefinition[] = [
  {
    modelId: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    description: "Google Gemini 3.7 Flash",
    supportedEfforts: ["high", "medium", "low"],
  },
  {
    modelId: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    description: "Google Gemini 3.6 Flash",
    supportedEfforts: ["high", "medium", "low"],
  },
  {
    modelId: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    description: "Google Gemini 3.1 Pro",
    supportedEfforts: ["high", "low"],
  },
  {
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    description: "Anthropic Claude Sonnet 4.6 (Thinking)",
    supportedEfforts: [],
  },
  {
    modelId: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    description: "Anthropic Claude Opus 4.6 (Thinking)",
    supportedEfforts: [],
  },
  {
    modelId: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    description: "GPT-OSS 120B (Medium)",
    supportedEfforts: ["medium"],
  },
];

let cachedModels: ModelDefinition[] | null = null;
let lastModelFetch = 0;
const MODEL_CACHE_TTL_MS = 60000; // 1 minute cache

export function parseAgyModelsOutput(rawOutput: string): ModelDefinition[] {
  const modelsMap = new Map<string, ModelDefinition>();

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("Fetching available models")) {
      continue;
    }
    const parts = trimmed.split(/\t+|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const modelId = parts[0];
      const label = parts[1];

      const effortMatch = modelId.match(/-(high|medium|low)$/);
      let baseId: string;
      let baseLabel: string;
      let effort: string | null = null;

      if (effortMatch) {
        effort = effortMatch[1];
        baseId = modelId.slice(0, -(effort.length + 1));
        baseLabel = label.replace(/\s*\((High|Medium|Low)\)$/, "");
      } else {
        baseId = modelId;
        baseLabel = label;
      }

      if (!modelsMap.has(baseId)) {
        modelsMap.set(baseId, {
          modelId: baseId,
          name: baseLabel,
          description: label,
          supportedEfforts: [],
        });
      }

      if (effort) {
        const entry = modelsMap.get(baseId)!;
        if (!entry.supportedEfforts.includes(effort)) {
          entry.supportedEfforts.push(effort);
        }
      }
    }
  }

  const result = Array.from(modelsMap.values());
  return result.length > 0 ? result : FALLBACK_MODELS;
}

export async function fetchAvailableModels(binaryPath: string = "agy"): Promise<ModelDefinition[]> {
  const now = Date.now();
  if (cachedModels && now - lastModelFetch < MODEL_CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const { stdout } = await execFileAsync(binaryPath, ["models"], {
      timeout: 5000,
      env: process.env,
    });
    const parsed = parseAgyModelsOutput(stdout);
    cachedModels = parsed;
    lastModelFetch = now;
    return parsed;
  } catch (err) {
    logger.warn("Failed to fetch models from agy CLI, using fallback models", {
      error: (err as Error).message,
    });
    cachedModels = FALLBACK_MODELS;
    lastModelFetch = now;
    return FALLBACK_MODELS;
  }
}

export function getEffectiveEffortForModel(
  modelId?: string,
  requestedEffort?: string,
  models?: ModelDefinition[]
): string | undefined {
  if (!modelId) {
    return undefined;
  }
  const modelList = models || cachedModels || FALLBACK_MODELS;
  const modelDef = modelList.find((m) => m.modelId === modelId);

  if (!modelDef || modelDef.supportedEfforts.length === 0) {
    return undefined;
  }

  if (requestedEffort && modelDef.supportedEfforts.includes(requestedEffort)) {
    return requestedEffort;
  }

  if (modelDef.supportedEfforts.includes("high")) {
    return "high";
  }

  return modelDef.supportedEfforts[0];
}

export const AVAILABLE_MODES = [
  {
    id: "default",
    name: "Default (Accept Edits)",
    description: "Standard autonomous execution and coding mode",
  },
  {
    id: "plan",
    name: "Plan Mode",
    description: "Planning and read-only analysis without file modifications",
  },
];

export function buildConfigOptionsForModel(
  modelId: string,
  currentEffort: string = "high",
  availableModels?: ModelDefinition[]
) {
  const modelList = availableModels || cachedModels || FALLBACK_MODELS;
  const modelDef = modelList.find((m) => m.modelId === modelId);
  const supported = modelDef ? modelDef.supportedEfforts : ["high", "medium", "low"];

  if (!supported || supported.length === 0) {
    return [];
  }

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
