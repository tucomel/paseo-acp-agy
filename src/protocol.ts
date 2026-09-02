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

// Available Models in Antigravity
export const AVAILABLE_MODELS = [
  {
    modelId: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash (High)",
    description: "Gemini 3.7 Flash with high reasoning effort (default)",
  },
  {
    modelId: "gemini-3.7-flash-medium",
    name: "Gemini 3.7 Flash (Medium)",
    description: "Gemini 3.7 Flash with medium reasoning effort",
  },
  {
    modelId: "gemini-3.7-flash-low",
    name: "Gemini 3.7 Flash (Low)",
    description: "Gemini 3.7 Flash with low reasoning effort",
  },
  {
    modelId: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash (High)",
    description: "Gemini 3.6 Flash model",
  },
  {
    modelId: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro (High)",
    description: "Gemini 3.1 Pro with high reasoning effort",
  },
  {
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    description: "Anthropic Claude Sonnet 4.6 with reasoning",
  },
  {
    modelId: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    description: "Anthropic Claude Opus 4.6 with reasoning",
  },
  {
    modelId: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    description: "Open weights 120B model",
  },
];

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
