import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { logger } from "./logger.js";
import {
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  ACP_METHODS,
  AVAILABLE_MODES,
  AVAILABLE_PERMISSIONS,
  fetchAvailableModels,
  buildConfigOptionsForModel,
  buildConfigOptionsForSession,
  extractPromptText,
  mapToolNameToKind,
  extractImageMarkdownLink,
  isNarrationText,
  AgyStepUpdateEvent,
  AgyResultEvent,
  ModelDefinition,
  calculateUsageCostUsd,
  roundUsageCostUsd,
  getModelContextWindow,
  fetchAntigravityUsage,
} from "./protocol.js";
import { SessionManager, Session } from "./session.js";
import { executeSlashCommand, AVAILABLE_SLASH_COMMANDS } from "./slash-commands.js";
import { getShortVersion } from "./version.js";
import { resolveDefaultAgyBinary } from "./antigravity-process.js";
import { loadConversationTranscript } from "./transcript.js";
import { normalizeToolCall, normalizeToolResult, extractPlanEntries } from "./tool-formatter.js";
import { McpBridge, McpServerConfig } from "./mcp-bridge.js";

function splitModelAndEffort(modelInput?: string): { model?: string; effort?: string } {
  if (!modelInput) return {};
  for (const effort of ["high", "medium", "low"] as const) {
    const suffix = `-${effort}`;
    if (modelInput.endsWith(suffix)) {
      return { model: modelInput.slice(0, -suffix.length), effort };
    }
  }
  return { model: modelInput };
}

export class ACPServer extends EventEmitter {
  private sessionManager: SessionManager;
  private mcpBridge: McpBridge;
  private input: Readable;
  private output: Writable;
  private binaryPath: string;
  private skipNarration: boolean;
  private rl: readline.Interface | null = null;
  private isRunning = false;
  private pendingRequests = new Map<string | number, {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
  }>();
  private nextRequestId = 1;

  constructor(options: {
    input?: Readable;
    output?: Writable;
    sessionManager?: SessionManager;
    binaryPath?: string;
    skipNarration?: boolean;
  } = {}) {
    super();
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.binaryPath = options.binaryPath || resolveDefaultAgyBinary();
    this.mcpBridge = new McpBridge(this.binaryPath);
    this.skipNarration =
      options.skipNarration ?? (process.env.AGY_ACP_SKIP_NARRATION === "true");
    this.sessionManager =
      options.sessionManager || new SessionManager({ defaultBinaryPath: this.binaryPath });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.output.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
        logger.debug("ACP output stream closed", { code: err.code });
      } else {
        logger.error("ACP output stream error", { error: err.message, code: err.code });
      }
    });

    this.rl = readline.createInterface({
      input: this.input,
      output: undefined,
      terminal: false,
    });
    this.rl.on("line", (line: string) => {
      this.handleLine(line).catch((err) => {
        logger.error("Error processing line in ACP server", { error: (err as Error).message });
      });
    });
    this.rl.on("close", () => {
      logger.info("ACP input stream closed, shutting down server");
      this.stop()
        .catch((err) => {
          logger.error("Error stopping ACP server on close", { error: (err as Error).message });
        })
        .finally(() => {
          this.emit("close");
        });
    });
    logger.info("ACP Server started");
  }

  private send(msg: unknown) {
    try {
      this.output.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      logger.warn("Failed to write to ACP output stream", { error: (err as Error).message });
    }
  }

  private sendNotification(method: string, params: unknown) {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.send(notification);
  }

  private sendSuccess(id: string | number, result: unknown) {
    const response: JsonRpcSuccessResponse = { jsonrpc: "2.0", id, result };
    this.send(response);
  }

  private sendError(id: string | number | null, code: number, message: string, data?: unknown) {
    const response: JsonRpcErrorResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.send(response);
  }

  public sendRequest<T = any>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private publishCommands(sessionId: string) {
    this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: AVAILABLE_SLASH_COMMANDS,
      },
    });
  }

  private publishUsageUpdate(session: Session) {
    const costUsd = roundUsageCostUsd(session.usage.totalCostUsd);
    const maxTokens = session.usage.contextWindowMaxTokens;
    const usedTokens = Math.min(session.usage.contextWindowUsedTokens, maxTokens);
    this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
      sessionId: session.id,
      update: {
        sessionUpdate: "usage_update",
        size: maxTokens,
        used: usedTokens,
        cost: { amount: costUsd, currency: "USD" },
        inputTokens: session.usage.inputTokens,
        outputTokens: session.usage.outputTokens,
        cachedReadTokens: session.usage.cachedInputTokens,
        cachedInputTokens: session.usage.cachedInputTokens,
        totalTokens: session.usage.totalTokens,
        totalCostUsd: costUsd,
        contextWindowMaxTokens: maxTokens,
        contextWindowUsedTokens: usedTokens,
      },
    });
  }

  private async sessionState(session: Session, forceModels = false) {
    const availableModels = await fetchAvailableModels(this.binaryPath, forceModels);
    return {
      sessionId: session.id,
      modes: {
        availableModes: AVAILABLE_MODES,
        currentModeId: session.mode,
      },
      models: {
        availableModels,
        currentModelId: session.model,
      },
      configOptions: buildConfigOptionsForSession({
        modelId: session.model,
        currentEffort: session.effort,
        currentMode: session.mode,
        currentPermission: session.permission,
        availableModels,
      }),
    };
  }

  private requireSession(sessionId: string): Session | null {
    return this.sessionManager.getSession(sessionId) || null;
  }

  private async validateModel(modelId: string): Promise<{
    models: ModelDefinition[];
    model: ModelDefinition | null;
  }> {
    const models = await fetchAvailableModels(this.binaryPath);
    return { models, model: models.find((candidate) => candidate.modelId === modelId) || null };
  }

  private turnUsagePayload(
    session: Session,
    turnUsage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      thinking_tokens?: number;
      total_tokens?: number;
    },
    executingModel?: string
  ) {
    const input = turnUsage?.input_tokens ?? 0;
    const output = turnUsage?.output_tokens ?? 0;
    const cached = turnUsage?.cache_read_tokens ?? 0;
    const thought = turnUsage?.thinking_tokens;
    const total = turnUsage?.total_tokens ?? (input + output);
    const maxTokens = getModelContextWindow(executingModel || session.model);
    const usedTokens = Math.min(session.usage.contextWindowUsedTokens, maxTokens);
    const costUsd = roundUsageCostUsd(session.usage.totalCostUsd);

    return {
      inputTokens: input,
      outputTokens: output,
      cachedReadTokens: cached,
      ...(thought !== undefined ? { thoughtTokens: thought } : {}),
      totalTokens: total,
      totalCostUsd: costUsd,
      cost: { amount: costUsd, currency: "USD" },
      size: maxTokens,
      used: usedTokens,
      contextWindowMaxTokens: maxTokens,
      contextWindowUsedTokens: usedTokens,
    };
  }

  private async handleLine(rawLine: string) {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.warn("Invalid JSON received on ACP stdio");
      this.sendError(null, -32700, "Parse error: invalid JSON");
      return;
    }

    const method = String(parsed.method || "");
    const id = parsed.id as string | number | undefined;
    const isNotification = id === undefined || id === null;
    const params = (parsed.params || {}) as Record<string, unknown>;
    logger.debug("Received ACP message", { method, isNotification, id });

    // Handle responses to requests initiated by the server (e.g. session/request_permission)
    if (id !== undefined && !method) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (parsed.error) {
          pending.reject(parsed.error);
        } else {
          pending.resolve(parsed.result);
        }
        return;
      }
    }

    try {
      switch (method) {
        case ACP_METHODS.INITIALIZE: {
          const clientInfo = (params.clientInfo || {}) as { name?: string; version?: string };
          logger.info("ACP Client connected", { clientInfo });
          if (!isNotification) {
            const shortVersion = getShortVersion();
            this.sendSuccess(id, {
              protocolVersion: 1,
              agentInfo: { name: "agy-acp", version: shortVersion },
              serverInfo: { name: "agy-acp", version: shortVersion },
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: {
                  resume: {},
                  list: {},
                  fork: {},
                },
              },
            });
          }
          break;
        }

        case ACP_METHODS.SESSION_NEW:
        case ACP_METHODS.SESSION_NEW_ALIAS: {
          const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
          const requestedModel = typeof params.model === "string" ? params.model : undefined;
          const parsedModel = splitModelAndEffort(requestedModel);
          const mode = typeof params.mode === "string" ? params.mode : undefined;
          const mcpServers = params.mcpServers as Record<string, McpServerConfig> | undefined;
          if (mcpServers) {
            void this.mcpBridge.syncServers(mcpServers);
          }
          const session = this.sessionManager.createSession({
            cwd,
            model: parsedModel.model,
            effort: parsedModel.effort,
            mode,
            binaryPath: this.binaryPath,
          });

          if (!isNotification) {
            this.sendSuccess(id, await this.sessionState(session, true));
            this.publishCommands(session.id);
            this.publishUsageUpdate(session);
            // Re-publish usage after ACPAgent completes awaiting newSession and stores this.sessionId
            setTimeout(() => {
              if (this.sessionManager.getSession(session.id)) {
                this.publishUsageUpdate(session);
              }
            }, 150);
            setTimeout(() => {
              if (this.sessionManager.getSession(session.id)) {
                this.publishUsageUpdate(session);
              }
            }, 500);
          }
          break;
        }

        case ACP_METHODS.SESSION_LOAD:
        case ACP_METHODS.SESSION_LOAD_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
          if (!sessionId) {
            if (!isNotification) this.sendError(id, -32602, "sessionId is required");
            break;
          }

          const mcpServers = params.mcpServers as Record<string, McpServerConfig> | undefined;
          if (mcpServers) {
            void this.mcpBridge.syncServers(mcpServers);
          }

          let session = this.sessionManager.getSession(sessionId);
          try {
            if (!session) {
              session = this.sessionManager.createSession({
                id: sessionId,
                cwd,
                binaryPath: this.binaryPath,
              });
            }

            const conversationId = session.process.currentConversationId;
            if (conversationId) {
              try {
                const replayItems = await loadConversationTranscript(conversationId);
                if (!session.title && replayItems.length > 0) {
                  const firstUser = replayItems.find((item) => item.type === "user_message");
                  if (firstUser && firstUser.text) {
                    session.setTitle(firstUser.text.slice(0, 80).replace(/\r?\n/g, " ").trim());
                  }
                }
                for (const item of replayItems) {
                  switch (item.type) {
                    case "user_message":
                      this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                        sessionId: session.id,
                        update: {
                          sessionUpdate: "user_message_chunk",
                          content: { type: "text", text: item.text },
                        },
                      });
                      break;
                    case "agent_thought":
                      this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                        sessionId: session.id,
                        update: {
                          sessionUpdate: "agent_thought_chunk",
                          content: { type: "text", text: item.text },
                        },
                      });
                      break;
                    case "tool_call":
                      this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                        sessionId: session.id,
                        update: {
                          sessionUpdate: "tool_call",
                          toolCallId: item.toolCallId,
                          title: item.title,
                          kind: item.kind,
                          rawInput: item.rawInput,
                        },
                      });
                      break;
                    case "tool_call_update":
                      this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                        sessionId: session.id,
                        update: {
                          sessionUpdate: "tool_call_update",
                          toolCallId: item.toolCallId,
                          status: item.status,
                          rawOutput: item.rawOutput,
                        },
                      });
                      break;
                    case "agent_message":
                      this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                        sessionId: session.id,
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: item.text },
                        },
                      });
                      break;
                  }
                }
              } catch (replayErr) {
                logger.warn("Failed to replay conversation transcript during session load", {
                  sessionId,
                  conversationId,
                  error: (replayErr as Error).message,
                });
              }
            }

            if (!isNotification) {
              this.sendSuccess(id, await this.sessionState(session));
              this.publishCommands(session.id);
              this.publishUsageUpdate(session);
              const activeSession = session;
              setTimeout(() => {
                if (this.sessionManager.getSession(activeSession.id)) {
                  this.publishUsageUpdate(activeSession);
                }
              }, 150);
            }
          } catch (err) {
            if (!isNotification) {
              this.sendError(
                id,
                -32603,
                `Failed to load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          break;
        }

        case ACP_METHODS.SESSION_RESUME:
        case ACP_METHODS.SESSION_RESUME_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
          if (!sessionId) {
            if (!isNotification) this.sendError(id, -32602, "sessionId is required");
            break;
          }

          let session = this.sessionManager.getSession(sessionId);
          let created = false;
          try {
            if (!session) {
              session = this.sessionManager.createSession({
                id: sessionId,
                cwd,
                binaryPath: this.binaryPath,
              });
              created = true;
            }
            await session.ensureReadyForResume();

            if (!isNotification) {
              this.sendSuccess(id, await this.sessionState(session));
              this.publishCommands(session.id);
              this.publishUsageUpdate(session);
            }
          } catch (err) {
            if (created || session) {
              await this.sessionManager.closeSession(sessionId).catch(() => false);
            }
            logger.warn("Failed to resume ACP session", {
              sessionId,
              error: (err as Error).message,
            });
            if (!isNotification) {
              this.sendError(id, -32602, `Unable to resume session ${sessionId}`, {
                reason: (err as Error).message,
              });
            }
          }
          break;
        }

        case ACP_METHODS.SESSION_LIST:
        case ACP_METHODS.SESSION_LIST_CAMEL:
        case ACP_METHODS.SESSION_LIST_ALIAS: {
          const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
          const sessions = this.sessionManager.listSessions(cwd);
          if (!isNotification) {
            this.sendSuccess(id, { sessions });
          }
          break;
        }

        case ACP_METHODS.SESSION_FORK:
        case ACP_METHODS.SESSION_FORK_ALIAS: {
          const sourceSessionId = String(params.sessionId || "");
          const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
          const sourceSession = sourceSessionId ? this.sessionManager.getSession(sourceSessionId) : undefined;
          const newSession = this.sessionManager.createSession({
            cwd: cwd || sourceSession?.cwd,
            model: sourceSession?.model,
            effort: sourceSession?.effort,
            mode: sourceSession?.mode,
            permission: sourceSession?.permission,
            conversationId: sourceSession?.process.currentConversationId,
            binaryPath: this.binaryPath,
          });
          if (sourceSession?.title) {
            newSession.setTitle(`${sourceSession.title} (fork)`);
          }
          if (!isNotification) {
            this.sendSuccess(id, await this.sessionState(newSession));
            this.publishCommands(newSession.id);
            this.publishUsageUpdate(newSession);
          }
          break;
        }

        case ACP_METHODS.SESSION_PROMPT:
        case ACP_METHODS.SESSION_PROMPT_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const session = this.requireSession(sessionId);
          if (!session) {
            if (!isNotification) this.sendError(id, -32602, `Session not found: ${sessionId}`);
            break;
          }

          if (!session.tryBeginPromptOperation()) {
            if (!isNotification) {
              this.sendError(id, -32000, "A prompt operation is already in progress on this session");
            }
            break;
          }

          // Snapshot the model that will actually execute this turn. A model
          // change received while the turn is running only applies after the
          // Antigravity process restarts for the next turn.
          const executingModel = session.model;

          try {
            session.touch();
            const promptText = extractPromptText(params.prompt);
            if (!session.title && promptText) {
              session.setTitle(promptText.slice(0, 80).replace(/\r?\n/g, " ").trim());
            }
            logger.info("Processing ACP prompt", {
              sessionId,
              promptLength: promptText.length,
              model: executingModel,
              effort: session.effort,
            });

            const slashResult = await executeSlashCommand(promptText, session, this.binaryPath);
            if (slashResult.handled) {
              if (session.isCancelled) {
                if (!isNotification) this.sendSuccess(id, { stopReason: "cancelled" });
                break;
              }
              if (slashResult.response) {
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: slashResult.response },
                  },
                });
              }
              if (!isNotification) this.sendSuccess(id, { stopReason: "end_turn" });
              break;
            }

            let hasSentNonNarration = false;
            let latestStepContextTokens: number | undefined;
            let stepCount = 0;
            const onStepUpdate = (event: AgyStepUpdateEvent) => {
              stepCount++;
              const step = event.step_update;
              if (!step) return;

              if (step.step_type === "agent_response" && step.text_delta) {
                if (this.skipNarration && !hasSentNonNarration) {
                  if (isNarrationText(step.text_delta)) {
                    logger.debug("Skipping pure narration text chunk", { delta: step.text_delta });
                    return;
                  }
                  hasSentNonNarration = true;
                }
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: step.text_delta },
                  },
                });

                // Live Plan / Todo checklist tracker
                const planEntries = extractPlanEntries(step.text_delta);
                if (planEntries) {
                  this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                    sessionId: session.id,
                    update: {
                      sessionUpdate: "plan",
                      entries: planEntries,
                    },
                  });
                }
              } else if (step.step_type === "thought" && step.text_delta) {
                hasSentNonNarration = true;
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: step.text_delta },
                  },
                });
              } else if (step.step_type === "tool" && step.tool_info) {
                hasSentNonNarration = true;
                const toolName = step.tool_name || step.tool_info.name || "tool";
                const toolCall = normalizeToolCall(
                  toolName,
                  (step.tool_info.parameters as Record<string, unknown>) || {},
                  step.step_index
                );

                if (step.state === "ACTIVE") {
                  this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                    sessionId: session.id,
                    update: {
                      sessionUpdate: "tool_call",
                      toolCallId: toolCall.toolCallId,
                      title: toolCall.title,
                      kind: toolCall.kind,
                      ...(toolCall.locations ? { locations: toolCall.locations } : {}),
                      rawInput: toolCall.rawInput,
                    },
                  });

                  if (toolName === "ask_question") {
                    const rawParams = (step.tool_info.parameters as Record<string, unknown>) || {};
                    const rawQuestions = Array.isArray(rawParams.questions)
                      ? (rawParams.questions as Array<{ question?: string; options?: string[]; is_multi_select?: boolean }>)
                      : [];

                    const options: Array<{ optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }> = [];
                    for (let qIdx = 0; qIdx < rawQuestions.length; qIdx++) {
                      const q = rawQuestions[qIdx];
                      const opts = Array.isArray(q.options) ? q.options : [];
                      for (let optIdx = 0; optIdx < opts.length; optIdx++) {
                        const opt = opts[optIdx];
                        const clean = typeof opt === "string" ? opt.replace(/^\(Recommended\)\s*/i, "").trim() : String(opt);
                        const isRec = typeof opt === "string" && (opt.includes("(Recommended)") || opt.includes("(Recomendado)"));
                        options.push({
                          optionId: `q${qIdx + 1}_opt${optIdx + 1}`,
                          name: `${clean}${isRec ? " (Recomendado)" : ""}`,
                          kind: "allow_once",
                        });
                      }
                    }
                    options.push({
                      optionId: "cancel",
                      name: "Cancelar",
                      kind: "reject_once",
                    });

                    const promptText = rawQuestions.map((q) => q.question).filter(Boolean).join(" / ") || "Pergunta do Assistente";
                    this.sendRequest("session/request_permission", {
                      sessionId: session.id,
                      toolCall: {
                        toolCallId: toolCall.toolCallId,
                        title: toolCall.title,
                        kind: "question",
                        content: [{ type: "text", text: promptText }],
                        rawInput: toolCall.rawInput,
                      },
                      options,
                      questions: rawQuestions,
                    }).then((permRes: any) => {
                      logger.info("Interactive question answered in Paseo", { permRes });
                      const outcome = permRes?.outcome;
                      let answerText = "";
                      if (outcome?._meta?.answers && typeof outcome._meta.answers === "object") {
                        answerText = Object.entries(outcome._meta.answers)
                          .map(([k, v]) => `• **${k}**: ${v}`)
                          .join("\n");
                      } else if (outcome?.optionId && outcome.optionId !== "cancel") {
                        const matched = options.find((o) => o.optionId === outcome.optionId);
                        answerText = matched ? matched.name : outcome.optionId;
                      }

                      if (answerText) {
                        this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                          sessionId: session.id,
                          update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                              type: "text",
                              text: `\n\n> 💡 **Opção Selecionada:**\n${answerText}\n\n`,
                            },
                          },
                        });
                      }
                    }).catch((err) => {
                      logger.debug("Interactive question cancelled or dismissed", { error: (err as Error).message });
                    });
                  }
                } else if (step.state === "DONE") {
                  const toolRes = normalizeToolResult(
                    toolName,
                    (step.tool_info.parameters as Record<string, unknown>) || {},
                    step.tool_info.output
                  );
                  this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                    sessionId: session.id,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: toolCall.toolCallId,
                      status: toolRes.status,
                      rawOutput: toolRes.rawOutput,
                      ...(toolRes.content ? { content: toolRes.content } : {}),
                    },
                  });

                  const imageMarkdown = extractImageMarkdownLink(
                    toolName,
                    step.tool_info.output,
                    step.tool_info.parameters as Record<string, unknown> | undefined
                  );
                  if (imageMarkdown) {
                    this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                      sessionId: session.id,
                      update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: `\n\n${imageMarkdown}\n\n` },
                      },
                    });
                  }
                } else if (step.state === "ERROR") {
                  const toolRes = normalizeToolResult(
                    toolName,
                    (step.tool_info.parameters as Record<string, unknown>) || {},
                    null,
                    step.tool_info.error || { message: "Tool execution error" }
                  );
                  this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                    sessionId: session.id,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: toolCall.toolCallId,
                      status: "failed",
                      rawOutput: toolRes.rawOutput,
                    },
                  });
                }
              }

              if (step.usage) {
                const inputTokens = step.usage.input_tokens ?? 0;
                const outputTokens = step.usage.output_tokens ?? 0;
                const cachedReadTokens = step.usage.cache_read_tokens ?? 0;
                if (inputTokens > 0 || cachedReadTokens > 0) {
                  latestStepContextTokens = inputTokens + cachedReadTokens + outputTokens;
                }
                const turnCost = calculateUsageCostUsd(
                  executingModel,
                  inputTokens,
                  outputTokens,
                  cachedReadTokens
                );
                const thoughtTokens = step.usage.thinking_tokens;
                const totalCostUsd = roundUsageCostUsd(session.usage.totalCostUsd + turnCost);
                const contextWindowMaxTokens = getModelContextWindow(executingModel);
                const stepContextUsed = Math.min(
                  latestStepContextTokens ?? (inputTokens + cachedReadTokens + outputTokens),
                  contextWindowMaxTokens
                );
                session.usage.contextWindowUsedTokens = stepContextUsed;

                const cumulativeInputTokens = session.usage.inputTokens + inputTokens;
                const cumulativeOutputTokens = session.usage.outputTokens + outputTokens;
                const cumulativeCachedTokens = session.usage.cachedInputTokens + cachedReadTokens;
                const cumulativeTotalTokens = cumulativeInputTokens + cumulativeOutputTokens;

                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "usage_update",
                    size: contextWindowMaxTokens,
                    used: stepContextUsed,
                    cost: { amount: totalCostUsd, currency: "USD" },
                    inputTokens: cumulativeInputTokens,
                    outputTokens: cumulativeOutputTokens,
                    cachedReadTokens: cumulativeCachedTokens,
                    cachedInputTokens: cumulativeCachedTokens,
                    ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
                    totalTokens: cumulativeTotalTokens,
                    totalCostUsd,
                    contextWindowMaxTokens,
                    contextWindowUsedTokens: stepContextUsed,
                    stepInputTokens: inputTokens,
                    stepOutputTokens: outputTokens,
                  },
                });
              }
            };

            try {
              let resultEvent: AgyResultEvent;
              try {
                resultEvent = await session.process.sendPrompt(
                  promptText,
                  onStepUpdate
                );
              } catch (firstErr) {
                const firstMsg = (firstErr as Error).message || "";
                if (
                  stepCount === 0 &&
                  !session.isCancelled &&
                  firstMsg.includes("agy process exited prematurely")
                ) {
                  logger.warn("agy process exited before streaming any steps; retrying prompt with fresh process", {
                    sessionId,
                    error: firstMsg,
                  });
                  resultEvent = await session.process.sendPrompt(
                    promptText,
                    onStepUpdate
                  );
                } else {
                  throw firstErr;
                }
              }

              const turnUsage = resultEvent.result?.usage;
              const numTurns = resultEvent.result?.num_turns || stepCount || 1;

              // Usage is billable even when the turn terminates with ERROR
              // after model/tool work. Record it before branching on status.
              session.recordTurnUsage(turnUsage, executingModel, latestStepContextTokens, numTurns);
              const usagePayload = this.turnUsagePayload(session, turnUsage, executingModel);
              this.publishUsageUpdate(session);

              if (session.isCancelled) {
                if (!isNotification) {
                  this.sendSuccess(id, { stopReason: "cancelled", usage: usagePayload });
                }
              } else if (resultEvent.result?.status === "ERROR") {
                const errorMessage = resultEvent.result.error || "Turn failed with an error";
                logger.error("Turn result reported error", { error: errorMessage, sessionId });
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `\n\n**Error:** ${errorMessage}\n` },
                  },
                });
                if (!isNotification) {
                  this.sendSuccess(id, { stopReason: "refusal", usage: usagePayload });
                }
              } else if (!isNotification) {
                this.sendSuccess(id, { stopReason: "end_turn", usage: usagePayload });
              }
            } catch (promptErr) {
              const errorMsg = (promptErr as Error).message || "Turn execution failed";
              if (
                session.isCancelled ||
                errorMsg.includes("cancelled") ||
                errorMsg.includes("Turn was cancelled")
              ) {
                if (!isNotification) this.sendSuccess(id, { stopReason: "cancelled" });
              } else {
                logger.error("Error executing prompt turn", { error: errorMsg, sessionId });
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `\n\n**Error:** ${errorMsg}\n` },
                  },
                });
                if (!isNotification) this.sendSuccess(id, { stopReason: "refusal" });
              }
            }
          } finally {
            session.endPromptOperation();
          }
          break;
        }

        case ACP_METHODS.SESSION_CANCEL:
        case ACP_METHODS.SESSION_CANCEL_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const session = this.requireSession(sessionId);
          if (session) {
            logger.info("Cancelling session prompt", { sessionId });
            session.cancelTurn();
          }
          if (!isNotification) this.sendSuccess(id, {});
          break;
        }

        case ACP_METHODS.SESSION_CLOSE:
        case ACP_METHODS.SESSION_CLOSE_ALIAS: {
          const sessionId = String(params.sessionId || "");
          await this.sessionManager.closeSession(sessionId);
          if (!isNotification) this.sendSuccess(id, {});
          break;
        }

        case ACP_METHODS.SESSION_SET_MODE:
        case ACP_METHODS.SESSION_SET_MODE_CAMEL:
        case ACP_METHODS.SESSION_SET_MODE_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const modeId = String(params.modeId || params.mode || "default");
          const session = this.requireSession(sessionId);
          if (!session) {
            if (!isNotification) this.sendError(id, -32602, `Session not found: ${sessionId}`);
            break;
          }
          if (!AVAILABLE_MODES.some((mode) => mode.id === modeId)) {
            if (!isNotification) this.sendError(id, -32602, `Unsupported mode: ${modeId}`);
            break;
          }
          session.setMode(modeId);
          if (!isNotification) this.sendSuccess(id, {});
          break;
        }

        case ACP_METHODS.SESSION_SET_MODEL:
        case ACP_METHODS.SESSION_SET_MODEL_CAMEL:
        case ACP_METHODS.SESSION_SET_MODEL_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const session = this.requireSession(sessionId);
          if (!session) {
            if (!isNotification) this.sendError(id, -32602, `Session not found: ${sessionId}`);
            break;
          }

          const requested = String(params.modelId || params.model || "");
          const parsedModel = splitModelAndEffort(requested);
          if (!parsedModel.model) {
            if (!isNotification) this.sendError(id, -32602, "modelId is required");
            break;
          }

          const { models, model } = await this.validateModel(parsedModel.model);
          if (!model) {
            if (!isNotification) this.sendError(id, -32602, `Unsupported model: ${parsedModel.model}`);
            break;
          }
          if (parsedModel.effort && !model.supportedEfforts.includes(parsedModel.effort)) {
            if (!isNotification) {
              this.sendError(
                id,
                -32602,
                `Model ${model.modelId} does not support effort ${parsedModel.effort}`
              );
            }
            break;
          }

          if (parsedModel.effort) session.setEffort(parsedModel.effort);
          session.setModel(model.modelId);
          const configOptions = buildConfigOptionsForSession({
            modelId: session.model,
            currentEffort: session.effort,
            currentMode: session.mode,
            currentPermission: session.permission,
            availableModels: models,
          });
          if (!isNotification) this.sendSuccess(id, { configOptions });
          break;
        }

        case ACP_METHODS.SESSION_SET_CONFIG_OPTION:
        case ACP_METHODS.SESSION_SET_CONFIG_OPTION_CAMEL:
        case ACP_METHODS.SESSION_SET_CONFIG_OPTION_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const configId = String(params.configId || "");
          const value = String(params.value || "");
          const session = this.requireSession(sessionId);
          if (!session) {
            if (!isNotification) this.sendError(id, -32602, `Session not found: ${sessionId}`);
            break;
          }

          const models = await fetchAvailableModels(this.binaryPath);
          if (configId === "thought_level" || configId === "effort") {
            const model = models.find((candidate) => candidate.modelId === session.model);
            if (!model || !model.supportedEfforts.includes(value)) {
              if (!isNotification) {
                this.sendError(
                  id,
                  -32602,
                  `Model ${session.model} does not support effort ${value}`
                );
              }
              break;
            }
            session.setEffort(value);
            logger.info("Updated reasoning effort for session", { sessionId, effort: value });
          } else if (configId === "model") {
            const model = models.find((candidate) => candidate.modelId === value);
            if (!model) {
              if (!isNotification) this.sendError(id, -32602, `Unsupported model: ${value}`);
              break;
            }
            session.setModel(value);
            logger.info("Updated model for session via config option", { sessionId, model: value });
          } else if (configId === "mode") {
            if (!AVAILABLE_MODES.some((candidate) => candidate.id === value)) {
              if (!isNotification) this.sendError(id, -32602, `Unsupported mode: ${value}`);
              break;
            }
            session.setMode(value);
            logger.info("Updated mode for session via config option", { sessionId, mode: value });
          } else if (configId === "permission") {
            if (!AVAILABLE_PERMISSIONS.some((candidate) => candidate.id === value)) {
              if (!isNotification) this.sendError(id, -32602, `Unsupported permission: ${value}`);
              break;
            }
            session.setPermission(value);
            logger.info("Updated permission for session via config option", { sessionId, permission: value });
          } else {
            if (!isNotification) this.sendError(id, -32602, `Unsupported config option: ${configId}`);
            break;
          }

          const configOptions = buildConfigOptionsForSession({
            modelId: session.model,
            currentEffort: session.effort,
            currentMode: session.mode,
            currentPermission: session.permission,
            availableModels: models,
          });
          if (!isNotification) this.sendSuccess(id, { configOptions });
          break;
        }

        case "provider/usage":
        case "antigravity/usage":
        case "session/usage": {
          const usage = await fetchAntigravityUsage(this.binaryPath);
          if (!isNotification) this.sendSuccess(id, usage);
          break;
        }

        default:
          if (!isNotification) this.sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (handlerErr) {
      logger.error("Internal handler error", { method, error: (handlerErr as Error).message });
      if (!isNotification) {
        this.sendError(id, -32603, "Internal error: " + (handlerErr as Error).message);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    await this.sessionManager.closeAll();
    logger.info("ACP Server stopped");
  }
}
