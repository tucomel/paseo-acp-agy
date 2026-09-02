import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger.js";
import { Session } from "./session.js";

const execFileAsync = promisify(execFile);

export interface SlashCommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
}

export const AVAILABLE_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    name: "resume",
    description: "Listar ou retomar uma sessão anterior (/resume ou /resume <id>)",
    argumentHint: "<conversation-ou-agent-id>",
  },
  {
    name: "usage",
    description: "Exibir uso e quota restante dos modelos (Gemini, Claude, GPT)",
  },
  {
    name: "quota",
    description: "Alias para /usage",
  },
  {
    name: "help",
    description: "Exibir lista de comandos e opções disponíveis",
  },
  {
    name: "credits",
    description: "Exibir saldo de créditos G1",
  },
  {
    name: "skills",
    description: "Listar skills instaladas no Antigravity",
  },
  {
    name: "agents",
    description: "Listar agentes disponíveis",
  },
  {
    name: "changelog",
    description: "Exibir notas de versão e novidades do Antigravity",
  },
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

export function listRecentConversations(limit: number = 10): RecentConversation[] {
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
  if (!fs.existsSync(brainDir)) {
    return [];
  }

  const results: RecentConversation[] = [];

  try {
    const entries = fs.readdirSync(brainDir);
    for (const cid of entries) {
      if (cid.length !== 36) continue;
      const logFile = path.join(brainDir, cid, ".system_generated", "logs", "transcript.jsonl");
      if (!fs.existsSync(logFile)) continue;

      try {
        const stat = fs.statSync(logFile);
        let firstPrompt = "";
        const content = fs.readFileSync(logFile, "utf8");
        const lines = content.split("\n").filter(Boolean);
        const totalSteps = lines.length;
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

        const date = new Date(stat.mtimeMs);
        const dateStr = date.toLocaleString("pt-BR", {
          timeZone: "America/Sao_Paulo",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });

        results.push({
          id: cid,
          mtime: stat.mtimeMs,
          dateStr,
          firstPrompt: firstPrompt || "(sem texto inicial)",
          totalSteps,
          userTurns,
        });
      } catch {}
    }
  } catch (err) {
    logger.warn("Failed to read recent conversations from brain", {
      error: (err as Error).message,
    });
  }

  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

export function getConversationSteps(cid: string): {
  totalSteps: number;
  userTurns: number;
  steps: ConversationStepItem[];
} | null {
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
  const logFile = path.join(brainDir, cid, ".system_generated", "logs", "transcript.jsonl");
  if (!fs.existsSync(logFile)) return null;

  try {
    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.split("\n").filter(Boolean);
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
          const toolCalls = data.tool_calls || [];
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
            role = "assistant";
            text = String(data.content).trim().replace(/\s+/g, " ").slice(0, 90);
          }
        }

        if (text) {
          steps.push({ index: idx, role, text });
        }
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

  if (steps.length <= 8) {
    for (const s of steps) {
      const roleLabel = s.role === "user" ? "User" : s.role === "tool" ? "Ferramenta" : "Assistente";
      md += `• **Step ${s.index}** *(${roleLabel})*: ${s.text}\n`;
    }
  } else {
    for (let i = 0; i < 2; i++) {
      const s = steps[i];
      const roleLabel = s.role === "user" ? "User" : s.role === "tool" ? "Ferramenta" : "Assistente";
      md += `• **Step ${s.index}** *(${roleLabel})*: ${s.text}\n`;
    }
    const hiddenCount = steps.length - 7;
    md += `• *... (${hiddenCount} passos intermediários ocultos) ...*\n`;
    for (let i = steps.length - 5; i < steps.length; i++) {
      const s = steps[i];
      const roleLabel = s.role === "user" ? "User" : s.role === "tool" ? "Ferramenta" : "Assistente";
      md += `• **Step ${s.index}** *(${roleLabel})*: ${s.text}\n`;
    }
  }
  return md;
}

export function resolveTargetConversationId(targetId: string): string | null {
  const cleanId = targetId.trim();
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");

  // Direct conversation ID check
  if (fs.existsSync(path.join(brainDir, cleanId))) {
    return cleanId;
  }

  // Prefix match on conversation ID
  try {
    const brainEntries = fs.readdirSync(brainDir);
    const match = brainEntries.find((e) => e.startsWith(cleanId) && e.length === 36);
    if (match) {
      return match;
    }
  } catch {}

  // Check Paseo agent store to see if targetId is a Paseo agent ID
  const paseoAgentsDir = path.join(os.homedir(), ".paseo", "agents");
  if (fs.existsSync(paseoAgentsDir)) {
    try {
      const subdirs = fs.readdirSync(paseoAgentsDir);
      for (const sub of subdirs) {
        const fullSub = path.join(paseoAgentsDir, sub);
        if (!fs.statSync(fullSub).isDirectory()) continue;
        const files = fs.readdirSync(fullSub);
        for (const file of files) {
          if (file.startsWith(cleanId) && file.endsWith(".json")) {
            const agentJson = JSON.parse(fs.readFileSync(path.join(fullSub, file), "utf8"));
            const pSessionId = agentJson.runtimeInfo?.sessionId;
            if (pSessionId) {
              const logPath = path.join(
                os.homedir(),
                ".local",
                "state",
                "agy-acp",
                "agy-acp.log"
              );
              if (fs.existsSync(logPath)) {
                const lines = fs.readFileSync(logPath, "utf8").split("\n");
                for (let i = lines.length - 1; i >= 0; i--) {
                  const line = lines[i];
                  if (line.includes(pSessionId) && line.includes("--conversation")) {
                    const matchConv = line.match(/--conversation",\s*"([a-f0-9-]+)"/);
                    if (matchConv) {
                      return matchConv[1];
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch {}
  }

  return null;
}

function renderProgressBar(percentage: number): string {
  const total = 10;
  const filled = Math.max(0, Math.min(total, Math.round((percentage / 100) * total)));
  return "█".repeat(filled) + "░".repeat(total - filled);
}

function getStatusBadge(percentage: number): string {
  if (percentage >= 70) return "🟢";
  if (percentage >= 30) return "🟡";
  return "🔴";
}

function formatCountdown(isoStr: string): string {
  try {
    const target = new Date(isoStr);
    const now = new Date();
    const diffMs = target.getTime() - now.getTime();
    if (diffMs <= 0) return "agora";
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
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

    if (diffHours < 24) {
      return `em **${diffHours}h ${diffMins}m** *(às ${timeStr})*`;
    }
    const days = Math.floor(diffHours / 24);
    const dayWord = days === 1 ? "dia" : "dias";
    return `em **${days} ${dayWord}** *(${dateStr} às ${timeStr})*`;
  } catch {
    return isoStr;
  }
}

export function formatUsageOutput(rawText: string): string {
  const lines = rawText.trim().split("\n");
  const groups = new Map<
    string,
    {
      icon: string;
      items: Array<{
        win: string;
        isFiveHour: boolean;
        pct: number;
        pctStr: string;
        reset: string;
      }>;
    }
  >();

  for (const line of lines) {
    const parts = line.includes("\t") ? line.split("\t") : line.split(/\s{2,}/);
    if (parts.length >= 3) {
      let fam = parts[0].trim();
      let icon = "🤖";
      if (fam.toLowerCase().includes("gemini")) {
        fam = "Google Gemini";
        icon = "🔷";
      } else if (fam.toLowerCase().includes("claude")) {
        fam = "Claude & GPT";
        icon = "🔶";
      }

      let win = parts[1].replace(" Remaining", "").trim();
      let isFiveHour = false;
      if (win.toLowerCase().includes("five hour") || win.includes("5")) {
        win = "Janela de 5 Horas";
        isFiveHour = true;
      } else if (win.toLowerCase().includes("weekly")) {
        win = "Cota Semanal";
      }

      const pctStr = parts[2].trim();
      const pct = parseInt(pctStr.replace("%", ""), 10) || 0;
      const reset = parts[3] ? parts[3].trim() : "";

      if (!groups.has(fam)) {
        groups.set(fam, { icon, items: [] });
      }
      groups.get(fam)!.items.push({ win, isFiveHour, pct, pctStr, reset });
    }
  }

  if (groups.size === 0) {
    return `### 📊 Quota de Uso do Antigravity\n\n\`\`\`text\n${rawText.trim()}\n\`\`\``;
  }

  let out = "### ⚡ Quotas de Uso — Antigravity\n\n";

  for (const [fam, data] of groups.entries()) {
    data.items.sort((a, b) => (b.isFiveHour ? 1 : 0) - (a.isFiveHour ? 1 : 0));

    out += `**${data.icon} ${fam}**\n`;
    for (const it of data.items) {
      const bar = renderProgressBar(it.pct);
      const icon = getStatusBadge(it.pct);
      const countdown = it.reset ? formatCountdown(it.reset) : "";
      out += `• **${it.win}:** ${icon} **${it.pctStr}** livre  \n`;
      out += `  \`[${bar}]\` · Reset ${countdown}\n`;
    }
    out += "\n";
  }

  out += "---\n> 💡 *A janela de 5 horas renova dinamicamente conforme o tempo passa.*";
  return out;
}

export async function executeSlashCommand(
  promptText: string,
  session: Session,
  binaryPath: string
): Promise<{ handled: boolean; response?: string }> {
  const trimmed = promptText.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

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
            response:
              "Nenhuma sessão anterior foi encontrada no histórico local do Antigravity.",
          };
        }

        let list = "### 📋 Sessões Recentes do Antigravity\n\n";
        for (const c of recent) {
          const stepsText =
            c.totalSteps > 0
              ? ` · 🟢 **${c.totalSteps} steps** (${c.userTurns} turno${c.userTurns !== 1 ? "s" : ""})`
              : "";
          list += `• **${c.dateStr}**${stepsText}  \n`;
          list += `  *${c.firstPrompt}*  \n`;
          list += `  \`/resume ${c.id}\`\n\n`;
        }
        list +=
          "---\n💡 *Copie ou digite `/resume <ID>` acima para retomar qualquer sessão.*";

        return { handled: true, response: list };
      }

      const resolvedConvId = resolveTargetConversationId(args);
      if (!resolvedConvId) {
        return {
          handled: true,
          response: `❌ **Sessão não encontrada.**\n\nNão foi possível localizar o histórico para \`${args}\`.\n\nDigite \`/resume\` sem argumentos para ver a lista de sessões disponíveis.`,
        };
      }

      await session.process.setConversationId(resolvedConvId);
      logger.info("Resumed conversation for session", {
        sessionId: session.id,
        conversationId: resolvedConvId,
      });

      const details = getConversationSteps(resolvedConvId);
      let stepsSection = "";
      if (details && details.steps.length > 0) {
        stepsSection = "\n" + formatStepsTimeline(details.steps) + "\n";
      }

      const stepsInfo = details
        ? `- **Total de Steps:** ${details.totalSteps} steps (${details.userTurns} turno${details.userTurns !== 1 ? "s" : ""})\n`
        : "";

      return {
        handled: true,
        response: `✅ **Sessão retomada com sucesso!**\n\n- **Conversation ID:** \`${resolvedConvId}\`\n${stepsInfo}- **Modelo Ativo:** \`${session.model}\`\n${stepsSection}---\n💡 *Contexto carregado. Envie sua próxima mensagem para continuar a partir de onde parou!*`,
      };
    }

    case "usage":
    case "quota": {
      try {
        const { stdout, stderr } = await execFileAsync(binaryPath, ["--print", "/usage"], {
          cwd: session.cwd,
        });
        const output = stdout.trim() || stderr.trim();
        return {
          handled: true,
          response: formatUsageOutput(output),
        };
      } catch (err) {
        return {
          handled: true,
          response: `Erro ao obter uso de quota: ${(err as Error).message}`,
        };
      }
    }

    case "credits": {
      try {
        const { stdout, stderr } = await execFileAsync(binaryPath, ["--print", "/credits"], {
          cwd: session.cwd,
        });
        const output = stdout.trim() || stderr.trim();
        return {
          handled: true,
          response: `### 💳 Saldo de Créditos Antigravity\n\n\`\`\`text\n${output}\n\`\`\``,
        };
      } catch (err) {
        return {
          handled: true,
          response: `Erro ao consultar créditos: ${(err as Error).message}`,
        };
      }
    }

    case "skills": {
      try {
        const { stdout, stderr } = await execFileAsync(binaryPath, ["--print", "/skills"], {
          cwd: session.cwd,
        });
        const output = stdout.trim() || stderr.trim();
        return {
          handled: true,
          response: `### 🛠️ Skills Instaladas\n\n\`\`\`text\n${output}\n\`\`\``,
        };
      } catch (err) {
        return {
          handled: true,
          response: `Erro ao listar skills: ${(err as Error).message}`,
        };
      }
    }

    case "agents": {
      try {
        const { stdout, stderr } = await execFileAsync(binaryPath, ["--print", "/agents"], {
          cwd: session.cwd,
        });
        const output = stdout.trim() || stderr.trim();
        return {
          handled: true,
          response: `### 🤖 Agentes Disponíveis\n\n\`\`\`text\n${output}\n\`\`\``,
        };
      } catch (err) {
        return {
          handled: true,
          response: `Erro ao listar agentes: ${(err as Error).message}`,
        };
      }
    }

    case "changelog": {
      try {
        const { stdout, stderr } = await execFileAsync(binaryPath, ["--print", "/changelog"], {
          cwd: session.cwd,
        });
        const output = stdout.trim() || stderr.trim();
        return {
          handled: true,
          response: `### 📜 Notas de Atualização (Changelog)\n\n${output}`,
        };
      } catch (err) {
        return {
          handled: true,
          response: `Erro ao buscar changelog: ${(err as Error).message}`,
        };
      }
    }

    case "help": {
      let help = "### 📖 Comandos Disponíveis no Antigravity (Paseo)\n\n";
      help += "| Comando | Descrição |\n";
      help += "|:---|:---|\n";
      help +=
        "| `/resume` | Lista as últimas 10 sessões disponíveis para retomada |\n";
      help +=
        "| `/resume <id>` | Retoma o histórico completo da sessão especificada |\n";
      help +=
        "| `/usage` | Exibe o consumo e cotas restantes (Gemini, Claude, GPT) |\n";
      help +=
        "| `/credits` | Exibe o saldo de créditos G1 |\n";
      help +=
        "| `/skills` | Lista as skills instaladas no ambiente |\n";
      help +=
        "| `/agents` | Lista os tipos de agentes configurados |\n";
      help +=
        "| `/changelog` | Exibe as notas de versão do Antigravity |\n";
      help +=
        "| `/help` | Exibe este painel de ajuda |\n";

      return { handled: true, response: help };
    }

    default:
      return { handled: false };
  }
}
