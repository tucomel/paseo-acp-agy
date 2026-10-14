import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "./logger.js";
import { mapToolNameToKind, ToolKind } from "./protocol.js";

export interface ReplayItem {
  type: "user_message" | "agent_message" | "agent_thought" | "tool_call" | "tool_call_update";
  text?: string;
  toolCallId?: string;
  title?: string;
  kind?: ToolKind;
  rawInput?: Record<string, unknown>;
  rawOutput?: string;
  status?: "completed" | "failed";
}

/**
 * Strips XML-like tags injected by harness or system prompts (e.g., <USER_REQUEST>, <ADDITIONAL_METADATA>)
 * to recover the clean user prompt for history display in clients like Paseo.
 */
export function extractCleanUserPrompt(rawText: string): string {
  if (!rawText) return "";
  const userRequestMatch = rawText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (userRequestMatch && userRequestMatch[1].trim()) {
    return userRequestMatch[1].trim();
  }
  // Remove additional metadata blocks if any
  const cleaned = rawText
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .trim();
  return cleaned || rawText.trim();
}

/**
 * Resolves the path to the Antigravity conversation directory in ~/.gemini/antigravity-cli/brain/<conversationId>
 */
export function resolveConversationBrainDir(conversationId: string): string | null {
  if (!conversationId) return null;
  const candidates: string[] = [];

  if (process.env.AGY_BRAIN_DIR) {
    candidates.push(path.join(process.env.AGY_BRAIN_DIR, conversationId));
  }
  if (process.env.AGY_APP_DATA_DIR) {
    candidates.push(path.join(process.env.AGY_APP_DATA_DIR, "brain", conversationId));
  }

  const home = os.homedir();
  if (home) {
    candidates.push(
      path.join(home, ".gemini", "antigravity-cli", "brain", conversationId),
      path.join(home, ".antigravity", "brain", conversationId)
    );
  }

  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return candidates[0] || null;
}

/**
 * Loads and parses transcript.jsonl (or transcript_full.jsonl) for a conversation,
 * transforming each step into ordered ACP replay events.
 */
export function loadConversationTranscript(conversationId: string): ReplayItem[] {
  const brainDir = resolveConversationBrainDir(conversationId);
  if (!brainDir) return [];

  const candidates = [
    path.join(brainDir, ".system_generated", "logs", "transcript.jsonl"),
    path.join(brainDir, ".system_generated", "logs", "transcript_full.jsonl"),
  ];

  let transcriptPath: string | null = null;
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      transcriptPath = cand;
      break;
    }
  }

  if (!transcriptPath) {
    logger.debug("No transcript file found for conversation", { conversationId, brainDir });
    return [];
  }

  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const replayItems: ReplayItem[] = [];
    let lastToolCallId: string | null = null;

    for (const line of lines) {
      let step: Record<string, unknown>;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }

      const stepIndex = typeof step.step_index === "number" ? step.step_index : 0;
      const stepType = String(step.type || "");

      if (stepType === "USER_INPUT") {
        const rawContent = typeof step.content === "string" ? step.content : "";
        const cleanPrompt = extractCleanUserPrompt(rawContent);
        if (cleanPrompt) {
          replayItems.push({
            type: "user_message",
            text: cleanPrompt,
          });
        }
      } else if (stepType === "PLANNER_RESPONSE") {
        // 1. Thinking / reasoning
        if (typeof step.thinking === "string" && step.thinking.trim()) {
          replayItems.push({
            type: "agent_thought",
            text: step.thinking,
          });
        }

        // 2. Tool calls
        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          for (let i = 0; i < step.tool_calls.length; i++) {
            const tc = step.tool_calls[i] as Record<string, unknown>;
            const rawArgs = (tc.args || tc.parameters || {}) as Record<string, unknown>;
            const toolName = String(tc.name || tc.tool_name || rawArgs.toolAction || "tool");
            const title = String(
              rawArgs.toolSummary ||
                rawArgs.toolAction ||
                tc.toolSummary ||
                tc.toolAction ||
                tc.name ||
                "tool"
            );
            const toolCallId = `tool_${stepIndex}_${i}`;
            lastToolCallId = toolCallId;
            replayItems.push({
              type: "tool_call",
              toolCallId,
              title,
              kind: mapToolNameToKind(toolName),
              rawInput: rawArgs,
            });
          }
        }

        // 3. Assistant message content
        if (typeof step.content === "string" && step.content.trim()) {
          replayItems.push({
            type: "agent_message",
            text: step.content,
          });
        }
      } else if (stepType === "GENERIC" && lastToolCallId) {
        // Tool result execution step
        const output = typeof step.content === "string" ? step.content : "";
        const isError = step.status === "ERROR";
        replayItems.push({
          type: "tool_call_update",
          toolCallId: lastToolCallId,
          status: isError ? "failed" : "completed",
          rawOutput: output,
        });
        lastToolCallId = null;
      }
    }

    return replayItems;
  } catch (err) {
    logger.warn("Failed to load conversation transcript for replay", {
      conversationId,
      error: (err as Error).message,
    });
    return [];
  }
}
