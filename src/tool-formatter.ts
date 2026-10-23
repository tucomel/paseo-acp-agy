import path from "node:path";
import { ToolKind } from "./protocol.js";

export interface NormalizedToolCall {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  locations?: Array<{ path: string; line?: number }>;
  rawInput: Record<string, unknown>;
  questionCard?: string;
}

export interface NormalizedToolResult {
  status: "completed" | "failed";
  rawOutput: string;
  content?: Array<Record<string, unknown>>;
  imageMarkdown?: string;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * Normalizes Antigravity tool calls into standard ACP format with descriptive titles,
 * proper kinds, clickable file locations, and normalized parameter names.
 */
export function normalizeToolCall(
  toolName: string,
  rawParams: Record<string, unknown> = {},
  stepIndex: number
): NormalizedToolCall {
  const toolCallId = `tool_${stepIndex}`;
  const normalizedParams: Record<string, unknown> = { ...rawParams };
  const name = toolName.toLowerCase();

  // 1. Shell commands: run_command
  if (
    name === "run_command" ||
    name.includes("command") ||
    name.includes("terminal") ||
    Boolean(rawParams.CommandLine) ||
    Boolean(rawParams.command)
  ) {
    const cmd = String(rawParams.CommandLine || rawParams.command || rawParams.cmd || "").trim();
    const summary = String(rawParams.toolSummary || rawParams.summary || "").trim();
    const title = summary || (cmd ? truncate(cmd, 60) : "run_command");
    normalizedParams.command = cmd;
    normalizedParams.CommandLine = cmd;

    return {
      toolCallId,
      title,
      kind: "execute",
      rawInput: normalizedParams,
    };
  }

  // 2. File reads: read_file, view_file, list_dir
  if (name === "read_file" || name === "view_file" || name === "list_dir" || name.includes("read")) {
    const rawPath = String(
      rawParams.Path || rawParams.path || rawParams.AbsolutePath || rawParams.filePath || rawParams.file || ""
    ).trim();
    const startLine = typeof rawParams.StartLine === "number" ? rawParams.StartLine : undefined;
    const base = rawPath ? path.basename(rawPath) : "read_file";
    const title = rawPath ? (startLine ? `${base}:${startLine}` : base) : "read_file";

    normalizedParams.path = rawPath;
    normalizedParams.filePath = rawPath;
    normalizedParams.Path = rawPath;

    return {
      toolCallId,
      title,
      kind: "read",
      locations: rawPath ? [{ path: rawPath, ...(startLine ? { line: startLine } : {}) }] : undefined,
      rawInput: normalizedParams,
    };
  }

  // 3. File edits / writes: edit_file, write_file, replace_file_content, multi_replace_file_content
  if (
    name === "edit_file" ||
    name === "write_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content" ||
    name === "sed_file" ||
    name.includes("edit") ||
    name.includes("write")
  ) {
    const rawPath = String(
      rawParams.Path || rawParams.path || rawParams.AbsolutePath || rawParams.filePath || rawParams.TargetFile || ""
    ).trim();
    const base = rawPath ? path.basename(rawPath) : "edit_file";
    const target = String(rawParams.Target || rawParams.oldText || rawParams.oldString || "");
    const replacement = String(rawParams.Replacement || rawParams.newText || rawParams.newString || rawParams.Content || "");

    normalizedParams.path = rawPath;
    normalizedParams.filePath = rawPath;
    normalizedParams.Path = rawPath;
    normalizedParams.oldText = target;
    normalizedParams.oldString = target;
    normalizedParams.newText = replacement;
    normalizedParams.newString = replacement;

    return {
      toolCallId,
      title: base,
      kind: "edit",
      locations: rawPath ? [{ path: rawPath }] : undefined,
      rawInput: normalizedParams,
    };
  }

  // 4. Search tools: search_web, grep_search, find_by_name
  if (name === "search_web" || name === "grep_search" || name === "find_by_name" || name.includes("search")) {
    const query = String(rawParams.query || rawParams.pattern || rawParams.CommandLine || "").trim();
    const title = query ? `Busca: ${truncate(query, 50)}` : "search";
    normalizedParams.query = query;

    return {
      toolCallId,
      title,
      kind: "search",
      rawInput: normalizedParams,
    };
  }

  // 5. Subagents: invoke_subagent, browser_subagent, manage_subagents
  if (name.includes("subagent")) {
    const role = String(rawParams.Role || rawParams.TypeName || rawParams.type || "Subagente").trim();
    const prompt = String(rawParams.Prompt || rawParams.prompt || "").trim();
    const title = `🤖 Subagente: ${role}`;
    normalizedParams.role = role;
    normalizedParams.prompt = prompt;

    return {
      toolCallId,
      title,
      kind: "execute",
      rawInput: normalizedParams,
    };
  }

  // 6. Interactive Questions: ask_question
  if (name === "ask_question") {
    const questions = Array.isArray(rawParams.questions) ? rawParams.questions : [];
    const questionCard = formatQuestionCard(questions);
    return {
      toolCallId,
      title: "❓ Pergunta do Assistente",
      kind: "other",
      rawInput: normalizedParams,
      questionCard: questionCard || undefined,
    };
  }

  // 7. General fallback
  const summary = String(rawParams.toolSummary || rawParams.summary || "").trim();
  return {
    toolCallId,
    title: summary || toolName,
    kind: "other",
    rawInput: normalizedParams,
  };
}

/**
 * Normalizes tool execution results into rich timeline content (diffs, terminals, text, images).
 */
export function normalizeToolResult(
  toolName: string,
  rawParams: Record<string, unknown> = {},
  output: unknown,
  error?: { message?: string }
): NormalizedToolResult {
  if (error) {
    return {
      status: "failed",
      rawOutput: error.message || "Tool execution error",
    };
  }

  const outputStr = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const name = toolName.toLowerCase();
  const content: Array<Record<string, unknown>> = [];

  // Edit tools: emit diff block so Paseo displays visual green/red syntax diffs
  if (
    name === "edit_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content" ||
    name === "write_file"
  ) {
    const filePath = String(rawParams.Path || rawParams.path || rawParams.AbsolutePath || "");
    const oldText = String(rawParams.Target || rawParams.oldText || rawParams.oldString || "");
    const newText = String(rawParams.Replacement || rawParams.newText || rawParams.newString || rawParams.Content || "");
    if (oldText || newText) {
      content.push({
        type: "diff",
        path: filePath,
        oldText,
        newText,
      });
    }
  } else if (name === "read_file" || name === "view_file") {
    if (outputStr.trim()) {
      content.push({
        type: "text",
        text: outputStr,
      });
    }
  }

  return {
    status: "completed",
    rawOutput: outputStr,
    content: content.length > 0 ? content : undefined,
  };
}

/**
 * Extracts markdown checklist / todo plan updates from assistant text or thoughts.
 */
export function extractPlanEntries(text: string): PlanEntry[] | null {
  if (!text || typeof text !== "string") return null;

  const lines = text.split(/\r?\n/);
  const entries: PlanEntry[] = [];

  for (const line of lines) {
    const match = line.match(/^[-*]\s+\[([ xX/\\-])\]\s+(.+)$/);
    if (match) {
      const mark = match[1].trim();
      const content = match[2].trim();
      let status: "pending" | "in_progress" | "completed" = "pending";
      if (mark === "x" || mark === "X") {
        status = "completed";
      } else if (mark === "/" || mark === "-") {
        status = "in_progress";
      }
      entries.push({ content, status });
    }
  }

  return entries.length >= 2 ? entries : null;
}

/**
 * Formats Antigravity's ask_question structure into a clear, responsive markdown card.
 * Supports multiple questions in a single call and single/multi-choice selection modes.
 */
function formatQuestionCard(questions: unknown[]): string {
  if (!questions || questions.length === 0) return "";

  const validQuestions = (questions as Array<{
    question?: string;
    options?: string[];
    is_multi_select?: boolean;
  }>).filter((q) => q && typeof q === "object");

  const total = validQuestions.length;
  const cards: string[] = [];

  for (let i = 0; i < total; i++) {
    const q = validQuestions[i];
    const prompt = q.question || "Escolha uma opção:";
    const options = Array.isArray(q.options) ? q.options : [];
    const isMulti = Boolean(q.is_multi_select);

    const titlePrefix = total > 1
      ? `### ❓ Pergunta ${i + 1} de ${total}`
      : `### ❓ Pergunta do Assistente`;

    let card = `${titlePrefix}\n> **${prompt}**\n\n`;

    if (options.length > 0) {
      if (isMulti) {
        card += `*☑️ Múltipla escolha (você pode selecionar mais de uma opção, ex: 1, 3):*\n`;
      } else {
        card += `*🔘 Escolha única (selecione uma das opções abaixo):*\n`;
      }

      card += options
        .map((opt, idx) => {
          const isRec = opt.includes("(Recommended)") || opt.includes("(Recomendado)");
          const clean = opt.replace(/^\(Recommended\)\s*/i, "").replace(/^\(Recomendado\)\s*/i, "");
          const mark = isMulti ? "- [ ]" : "-";
          return `${mark} **[${idx + 1}]** ${clean}${isRec ? " *(Recomendado)*" : ""}`;
        })
        .join("\n");
    }
    cards.push(card);
  }

  return cards.join("\n\n---\n\n");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
