import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger.js";
import { Session } from "./session.js";
import { sessionStore } from "./session-store.js";
import { formatExecBinaryPath } from "./protocol.js";

const execFileAsync = promisify(execFile);
const AGY_COMMAND_TIMEOUT_MS = 30_000;
const AGY_COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_LOOKUP_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const SAFE_CONVERSATION_PREFIX_RE = /^[0-9a-f-]{6,36}$/i;

export interface SlashCommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
}

export const AVAILABLE_SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: "resume", description: "Listar ou retomar uma sessão anterior (/resume ou /resume <id>)", argumentHint: "<conversation-ou-agent-id>" },
  { name: "usage", description: "Exibir uso e quota restante dos modelos (Gemini, Claude, GPT)" },
  { name: "quota", description: "Alias para /usage" },
  { name: "help", description: "Exibir lista de comandos e opções disponíveis" },
  { name: "credits", description: "Exibir saldo de créditos G1" },
  { name: "skills", description: "Listar skills instaladas no Antigravity" },
  { name: "agents", description: "Listar agentes disponíveis" },
  { name: "changelog", description: "Exibir notas de versão e novidades do Antigravity" },
];

export interface RecentConversation {
  id: string;
  mtime: number;
  dateStr: string;
  firstPrompt: string;
  totalSteps: number;
  userTurns: number;
}

export interface ConversationStepItem {
  index: number;
  role: "user" | "assistant" | "tool";
  text: string;
}

function brainDir(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
}

function transcriptPath(conversationId: string): string | null {
  if (!UUID_RE.test(conversationId)) return null;
  return path.join(brainDir(), conversationId, ".system_generated", "logs", "transcript.jsonl");
}

function summarizeConversation(cid: string, logFile: string, mtime: number): RecentConversation | null {
  try {
    const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    let firstPrompt = "";
    let userTurns = 0;
    for (const line of lines) {
      if (!line.includes('"USER_INPUT"')) continue;
      userTurns++;
      if (!firstPrompt) {
        try {
          const parsed = JSON.parse(line);
          let text = String(parsed.content || "");
          if (text.includes("<USER_REQUEST>")) {
            text = text.split("<USER_REQUEST>")[1].split("</USER_REQUEST>")[0];
          }
          firstPrompt = text.trim().replace(/\s+/g, " ").slice(0, 80);
        } catch {}
      }
    }
    const date = new Date(mtime);
    return {
      id: cid,
      mtime,
      dateStr: date.toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      firstPrompt: firstPrompt || "(sem texto inicial)",
      totalSteps: lines.length,
      userTurns,
    };
  } catch {
    return null;
  }
}

export function listRecentConversations(limit = 10): RecentConversation[] {
  const root = brainDir();
  if (!fs.existsSync(root) || limit <= 0) return [];

  try {
    // Stat every candidate first, then read only the newest transcripts. This
    // keeps /resume proportional to the requested result count instead of the
    // total accumulated history size.
    const candidates: Array<{ id: string; logFile: string; mtime: number }> = [];
    for (const cid of fs.readdirSync(root)) {
      if (!UUID_RE.test(cid)) continue;
      const logFile = transcriptPath(cid);
      if (!logFile || !fs.existsSync(logFile)) continue;
      try {
        candidates.push({ id: cid, logFile, mtime: fs.statSync(logFile).mtimeMs });
      } catch {}
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    const results: RecentConversation[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      const summary = summarizeConversation(candidate.id, candidate.logFile, candidate.mtime);
      if (summary) results.push(summary);
    }
    return results;
  } catch (err) {
    logger.warn("Failed to read recent conversations from brain", {
      error: (err as Error).message,
    });
    return [];
  }
}

export function getConversationSteps(cid: string): {
  totalSteps: number;
  userTurns: number;
  steps: ConversationStepItem[];
} | null {
  const logFile = transcriptPath(cid);
  if (!logFile || !fs.existsSync(logFile)) return null;
  try {
    const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    const steps: ConversationStepItem[] = [];
    let userTurns = 0;
    for (let i = 0; i < lines.length; i++) {
      try {
        const data = JSON.parse(lines[i]);
        const idx = typeof data.step_index === "number" ? data.step_index : i;
        const type = data.type;
        let text = "";
        let role: "user" | "assistant" | "tool" = "assistant";
        if (type === "USER_INPUT") {
          userTurns++;
          role = "user";
          let raw = String(data.content || "");
          if (raw.includes("<USER_REQUEST>")) {
            raw = raw.split("<USER_REQUEST>")[1].split("</USER_REQUEST>")[0];
          }
          text = raw.trim().replace(/\s+/g, " ").slice(0, 90);
        } else if (type === "PLANNER_RESPONSE") {
          const toolCalls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
          if (toolCalls.length > 0) {
            role = "tool";
            const toolNames = toolCalls.map((tc: any) => {
              const name = tc.name || tc.tool_name || "tool";
              let target = "";
              if (tc.args) {
                if (typeof tc.args.AbsolutePath === "string") {
                  target = path.basename(tc.args.AbsolutePath.replace(/"/g, ""));
                } else if (typeof tc.args.CommandLine === "string") {
                  target = tc.args.CommandLine.slice(0, 25);
                }
              }
              return target ? `${name}(${target})` : name;
            });
            text = "Ferramenta: " + toolNames.join(", ");
          } else if (data.content) {
            text = String(data.content).trim().replace(/\s+/g, " ").slice(0, 90);
          }
        }
        if (text) steps.push({ index: idx, role, text });
      } catch {}
    }
    return { totalSteps: lines.length, userTurns, steps };
  } catch {
    return null;
  }
}

export function formatStepsTimeline(steps: ConversationStepItem[]): string {
  if (steps.length === 0) return "";
  let md = "#### 📜 Histórico de Passos (Steps):\n";
  const append = (step: ConversationStepItem) => {
    const roleLabel =
      step.role === "user" ? "User" : step.role === "tool" ? "Ferramenta" : "Assistente";
    md += `• **Step ${step.index}** *(${roleLabel})*: ${step.text}\n`;
  };
  if (steps.length <= 8) {
    steps.forEach(append);
  } else {
    steps.slice(0, 2).forEach(append);
    md += `• *... (${steps.length - 7} passos intermediários ocultos) ...*\n`;
    steps.slice(-5).forEach(append);
  }
  return md;
}

export function resolveTargetConversationId(targetId: string): string | null {
  const cleanId = targetId.trim();
  if (!cleanId || !SAFE_LOOKUP_ID_RE.test(cleanId)) return null;

  const persisted = sessionStore.load(cleanId);
  if (persisted?.conversationId && UUID_RE.test(persisted.conversationId)) {
    return persisted.conversationId;
  }

  const root = brainDir();
  if (UUID_RE.test(cleanId) && fs.existsSync(path.join(root, cleanId))) return cleanId;
  if (SAFE_CONVERSATION_PREFIX_RE.test(cleanId)) {
    try {
      const matches = fs
        .readdirSync(root)
        .filter((entry) => UUID_RE.test(entry) && entry.startsWith(cleanId));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    } catch {}
  }

  const paseoAgentsDir = path.join(os.homedir(), ".paseo", "agents");
  if (!fs.existsSync(paseoAgentsDir)) return null;
  try {
    for (const sub of fs.readdirSync(paseoAgentsDir)) {
      const fullSub = path.join(paseoAgentsDir, sub);
      if (!fs.statSync(fullSub).isDirectory()) continue;
      for (const file of fs.readdirSync(fullSub)) {
        if (!file.startsWith(cleanId) || !file.endsWith(".json")) continue;
        const agentJson = JSON.parse(fs.readFileSync(path.join(fullSub, file), "utf8"));
        const paseoSessionId = agentJson.runtimeInfo?.sessionId;
        if (typeof paseoSessionId !== "string") continue;
        const state = sessionStore.load(paseoSessionId);
        if (state?.conversationId && UUID_RE.test(state.conversationId)) {
          return state.conversationId;
        }
      }
    }
  } catch {}
  return null;
}

function renderProgressBar(percentage: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percentage / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function getStatusBadge(percentage: number): string {
  if (percentage >= 70) return "🟢";
  if (percentage >= 30) return "🟡";
  return "🔴";
}

function formatCountdown(isoStr: string): string {
  try {
    const target = new Date(isoStr);
    const diffMs = target.getTime() - Date.now();
    if (!Number.isFinite(diffMs)) return isoStr;
    if (diffMs <= 0) return "agora";
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffMins = Math.floor((diffMs % 3_600_000) / 60_000);
    const timeStr = target.toLocaleTimeString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
    });
    const dateStr = target.toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
    });
    if (diffHours < 24) return `em **${diffHours}h ${diffMins}m** *(às ${timeStr})*`;
    const days = Math.floor(diffHours / 24);
    return `em **${days} ${days === 1 ? "dia" : "dias"}** *(${dateStr} às ${timeStr})*`;
  } catch {
    return isoStr;
  }
}

export function formatUsageOutput(rawText: string): string {
  const groups = new Map<
    string,
    {
      icon: string;
      items: Array<{ win: string; isFiveHour: boolean; pct: number; pctStr: string; reset: string }>;
    }
  >();
  for (const line of rawText.trim().split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.toLowerCase().startsWith("quota:")) continue;

    let fam = "";
    let rawWindow = "";
    let pctStr = "";
    let reset = "";

    const m = trimmedLine.match(/^(.*?)\s{2,}(.*?Remaining)\s+(\d+%)(?:\s+(.*))?$/i);
    if (m) {
      fam = m[1].trim();
      rawWindow = m[2].trim();
      pctStr = m[3].trim();
      reset = m[4]?.trim() || "";
    } else {
      const parts = trimmedLine.includes("\t") ? trimmedLine.split("\t") : trimmedLine.split(/\s{2,}/);
      if (parts.length < 3) continue;
      fam = parts[0].trim();
      rawWindow = parts[1].trim();
      pctStr = parts[2].trim();
      reset = parts[3]?.trim() || "";
    }

    let icon = "🤖";
    if (fam.toLowerCase().includes("gemini")) {
      fam = "Google Gemini";
      icon = "🔷";
    } else if (fam.toLowerCase().includes("claude")) {
      fam = "Claude & GPT";
      icon = "🔶";
    }
    rawWindow = rawWindow.replace(/\s+Remaining$/i, "").trim();
    const lowerWindow = rawWindow.toLowerCase();
    const isFiveHour = lowerWindow.includes("five hour") || /\b5\s*hour/.test(lowerWindow);
    const win = isFiveHour
      ? "Janela de 5 Horas"
      : lowerWindow.includes("weekly")
        ? "Cota Semanal"
        : rawWindow;
    const parsedPct = Number.parseInt(pctStr.replace("%", ""), 10);
    const pct = Number.isFinite(parsedPct) ? parsedPct : 0;
    if (!groups.has(fam)) groups.set(fam, { icon, items: [] });
    groups.get(fam)!.items.push({ win, isFiveHour, pct, pctStr, reset });
  }

  if (groups.size === 0) {
    return `### 📊 Quota de Uso do Antigravity\n\n\`\`\`text\n${rawText.trim()}\n\`\`\``;
  }

  let out = "### ⚡ Quotas de Uso — Antigravity\n\n";
  for (const [fam, data] of groups.entries()) {
    data.items.sort((a, b) => Number(b.isFiveHour) - Number(a.isFiveHour));
    out += `**${data.icon} ${fam}**\n`;
    for (const item of data.items) {
      out += `• **${item.win}:** ${getStatusBadge(item.pct)} **${item.pctStr}** livre  \n`;
      out += `  \`[${renderProgressBar(item.pct)}]\` · Reset ${
        item.reset ? formatCountdown(item.reset) : ""
      }\n`;
    }
    out += "\n";
  }
  out += "---\n> 💡 *A janela de 5 horas renova dinamicamente conforme o tempo passa.*";
  return out;
}

async function runAgySlash(binaryPath: string, cwd: string, slashCommand: string): Promise<string> {
  const cmd = formatExecBinaryPath(binaryPath);
  const { stdout, stderr } = await execFileAsync(cmd, ["--print", slashCommand], {
    cwd,
    env: process.env,
    timeout: AGY_COMMAND_TIMEOUT_MS,
    maxBuffer: AGY_COMMAND_MAX_BUFFER,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return stdout.trim() || stderr.trim();
}

export async function executeSlashCommand(
  promptText: string,
  session: Session,
  binaryPath: string
): Promise<{ handled: boolean; response?: string }> {
  const trimmed = promptText.trim();
  if (!trimmed.startsWith("/")) return { handled: false };
  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ").trim();
  logger.info("Intercepted slash command", { command, args, sessionId: session.id });

  switch (command) {
    case "resume": {
      if (!args) {
        const recent = listRecentConversations(10);
        if (recent.length === 0) {
          return {
            handled: true,
            response: "Nenhuma sessão anterior foi encontrada no histórico local do Antigravity.",
          };
        }
        let list = "### 📋 Sessões Recentes do Antigravity\n\n";
        for (const conversation of recent) {
          const stepsText = conversation.totalSteps > 0
            ? ` · 🟢 **${conversation.totalSteps} steps** (${conversation.userTurns} turno${
                conversation.userTurns !== 1 ? "s" : ""
              })`
            : "";
          list += `• **${conversation.dateStr}**${stepsText}  \n  *${conversation.firstPrompt}*  \n  \`/resume ${conversation.id}\`\n\n`;
        }
        list += "---\n💡 *Copie ou digite `/resume <ID>` acima para retomar qualquer sessão.*";
        return { handled: true, response: list };
      }

      const resolvedConvId = resolveTargetConversationId(args);
      if (!resolvedConvId) {
        return {
          handled: true,
          response: `❌ **Sessão não encontrada.**\n\nNão foi possível localizar o histórico para \`${args}\`.\n\nDigite \`/resume\` sem argumentos para ver a lista de sessões disponíveis.`,
        };
      }

      try {
        // Validate --conversation immediately instead of reporting success and
        // discovering a broken resume on the user's next message.
        await session.resumeConversation(resolvedConvId);
      } catch (err) {
        return {
          handled: true,
          response: `❌ **Falha ao retomar sessão.**\n\n${(err as Error).message}`,
        };
      }

      logger.info("Resumed conversation for session", {
        sessionId: session.id,
        conversationId: resolvedConvId,
      });
      const details = getConversationSteps(resolvedConvId);
      const stepsSection = details?.steps.length ? `\n${formatStepsTimeline(details.steps)}\n` : "";
      const stepsInfo = details
        ? `- **Total de Steps:** ${details.totalSteps} steps (${details.userTurns} turno${
            details.userTurns !== 1 ? "s" : ""
          })\n`
        : "";
      return {
        handled: true,
        response: `✅ **Sessão retomada com sucesso!**\n\n- **Conversation ID:** \`${resolvedConvId}\`\n${stepsInfo}- **Modelo Ativo:** \`${session.model}\`\n${stepsSection}---\n💡 *Contexto carregado. Envie sua próxima mensagem para continuar a partir de onde parou!*`,
      };
    }

    case "usage":
    case "quota":
      try {
        return { handled: true, response: formatUsageOutput(await runAgySlash(binaryPath, session.cwd, "/usage")) };
      } catch (err) {
        return { handled: true, response: `Erro ao obter uso de quota: ${(err as Error).message}` };
      }
    case "credits":
      try {
        return { handled: true, response: `### 💳 Saldo de Créditos Antigravity\n\n\`\`\`text\n${await runAgySlash(binaryPath, session.cwd, "/credits")}\n\`\`\`` };
      } catch (err) {
        return { handled: true, response: `Erro ao consultar créditos: ${(err as Error).message}` };
      }
    case "skills":
      try {
        return { handled: true, response: `### 🛠️ Skills Instaladas\n\n\`\`\`text\n${await runAgySlash(binaryPath, session.cwd, "/skills")}\n\`\`\`` };
      } catch (err) {
        return { handled: true, response: `Erro ao listar skills: ${(err as Error).message}` };
      }
    case "agents":
      try {
        return { handled: true, response: `### 🤖 Agentes Disponíveis\n\n\`\`\`text\n${await runAgySlash(binaryPath, session.cwd, "/agents")}\n\`\`\`` };
      } catch (err) {
        return { handled: true, response: `Erro ao listar agentes: ${(err as Error).message}` };
      }
    case "changelog":
      try {
        return { handled: true, response: `### 📜 Notas de Atualização (Changelog)\n\n${await runAgySlash(binaryPath, session.cwd, "/changelog")}` };
      } catch (err) {
        return { handled: true, response: `Erro ao buscar changelog: ${(err as Error).message}` };
      }
    case "help":
      return {
        handled: true,
        response:
          "### 📖 Comandos Disponíveis no Antigravity (Paseo)\n\n| Comando | Descrição |\n|:---|:---|\n| `/resume` | Lista as últimas 10 sessões disponíveis para retomada |\n| `/resume <id>` | Retoma e valida a sessão especificada |\n| `/usage` | Exibe o consumo e cotas restantes (Gemini, Claude, GPT) |\n| `/credits` | Exibe o saldo de créditos G1 |\n| `/skills` | Lista as skills instaladas no ambiente |\n| `/agents` | Lista os tipos de agentes configurados |\n| `/changelog` | Exibe as notas de versão do Antigravity |\n| `/help` | Exibe este painel de ajuda |\n",
      };
    default:
      return { handled: false };
  }
}
