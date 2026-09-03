import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { logger } from "./logger.js";
import {
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  ACP_METHODS,
  AVAILABLE_MODES,
  fetchAvailableModels,
  buildConfigOptionsForModel,
  extractPromptText,
  mapToolNameToKind,
  AgyStepUpdateEvent,
  AgyResultEvent,
  ModelDefinition,
} from "./protocol.js";
import { SessionManager, Session } from "./session.js";
import { executeSlashCommand, AVAILABLE_SLASH_COMMANDS } from "./slash-commands.js";

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

export class ACPServer {
  private sessionManager: SessionManager;
  private input: Readable;
  private output: Writable;
  private binaryPath: string;
  private rl: readline.Interface | null = null;
  private isRunning = false;

  constructor(options: {
    input?: Readable;
    output?: Writable;
    sessionManager?: SessionManager;
    binaryPath?: string;
  } = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.binaryPath = options.binaryPath || process.env.AGY_BIN_PATH || "agy";
    this.sessionManager =
      options.sessionManager || new SessionManager({ defaultBinaryPath: this.binaryPath });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
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
      this.stop().catch((err) => {
        logger.error("Error stopping ACP server on close", { error: (err as Error).message });
      });
    });
    logger.info("ACP Server started");
  }

  private send(msg: unknown) {
    this.output.write(JSON.stringify(msg) + "\n");
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

  private publishCommands(sessionId: string) {
    this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: AVAILABLE_SLASH_COMMANDS,
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
      configOptions: buildConfigOptionsForModel(
        session.model,
        session.effort,
        availableModels
      ),
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

    try {
      switch (method) {
        case ACP_METHODS.INITIALIZE: {
          const clientInfo = (params.clientInfo || {}) as { name?: string; version?: string };
          logger.info("ACP Client connected", { clientInfo });
          if (!isNotification) {
            this.sendSuccess(id, {
              protocolVersion: "1.0.0",
              serverInfo: { name: "agy-acp", version: "1.0.0" },
              agentCapabilities: {
                // session/load requires history replay through session/update.
                // agy-acp intentionally exposes resume-only persistence until
                // that replay contract is implemented.
                loadSession: false,
                sessionCapabilities: { resume: true },
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
          }
          break;
        }

        case ACP_METHODS.SESSION_LOAD:
        case ACP_METHODS.SESSION_LOAD_ALIAS: {
          if (!isNotification) {
            this.sendError(
              id,
              -32601,
              "session/load is not supported because agy-acp does not replay prior history; use session/resume"
            );
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

            // Validate the persisted Antigravity conversation now. Do not tell
            // Paseo that resume succeeded and defer a broken --conversation to
            // the next user prompt.
            await session.ensureReadyForResume();

            if (!isNotification) {
              this.sendSuccess(id, await this.sessionState(session));
              this.publishCommands(session.id);
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

        case ACP_METHODS.SESSION_PROMPT:
        case ACP_METHODS.SESSION_PROMPT_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const session = this.requireSession(sessionId);
          if (!session) {
            if (!isNotification) this.sendError(id, -32602, `Session not found: ${sessionId}`);
            break;
          }

          // Reserve at the session boundary before the first await. This covers
          // both intercepted slash commands and ordinary prompts, so a second
          // session/prompt cannot enter while an async slash command is running.
          if (!session.tryBeginPromptOperation()) {
            if (!isNotification) {
              this.sendError(id, -32000, "A prompt operation is already in progress on this session");
            }
            break;
          }

          try {
            session.touch();
            const promptText = extractPromptText(params.prompt);
            logger.info("Processing ACP prompt", {
              sessionId,
              promptLength: promptText.length,
              model: session.model,
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

            const onStepUpdate = (event: AgyStepUpdateEvent) => {
              const step = event.step_update;
              if (!step) return;

              if (step.step_type === "agent_response" && step.text_delta) {
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: step.text_delta },
                  },
                });
              } else if (step.step_type === "thought" && step.text_delta) {
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: step.text_delta },
                  },
                });
              } else if (step.step_type === "tool" && step.tool_info) {
                const toolCallId = `tool_${step.step_index}`;
                const toolName = step.tool_name || step.tool_info.name || "tool";
                const toolKind = mapToolNameToKind(toolName);
                if (step.state === "ACTIVE") {
                  this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                    sessionId: session.id,
                    update: {
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: toolName,
                      kind: toolKind,
                      rawInput: step.tool_info.parameters || {},
                    },
                  });
                } else if (step.state === "DONE") {
                  this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                    sessionId: session.id,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                      rawOutput: step.tool_info.output ?? "",
                    },
                  });
                } else if (step.state === "ERROR") {
                  this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                    sessionId: session.id,
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "failed",
                      rawOutput: step.tool_info.error?.message || "Tool execution error",
                    },
                  });
                }
              }

              if (step.usage) {
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "usage_update",
                    inputTokens: step.usage.input_tokens,
                    outputTokens: step.usage.output_tokens,
                    cachedReadTokens: step.usage.cache_read_tokens,
                  },
                });
              }
            };

            try {
              const resultEvent: AgyResultEvent = await session.process.sendPrompt(
                promptText,
                onStepUpdate
              );
              if (session.isCancelled) {
                if (!isNotification) this.sendSuccess(id, { stopReason: "cancelled" });
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
                if (!isNotification) this.sendSuccess(id, { stopReason: "refusal" });
              } else if (!isNotification) {
                this.sendSuccess(id, { stopReason: "end_turn" });
              }
            } catch (promptErr) {
              if (session.isCancelled) {
                if (!isNotification) this.sendSuccess(id, { stopReason: "cancelled" });
              } else {
                const errorMsg = (promptErr as Error).message || "Turn execution failed";
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
          const configOptions = buildConfigOptionsForModel(
            session.model,
            session.effort,
            models
          );
          if (!isNotification) this.sendSuccess(id, { configOptions });
          break;
        }

        case ACP_METHODS.SESSION_SET_CONFIG_OPTION:
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
          } else {
            if (!isNotification) this.sendError(id, -32602, `Unsupported config option: ${configId}`);
            break;
          }

          const configOptions = buildConfigOptionsForModel(
            session.model,
            session.effort,
            models
          );
          if (!isNotification) this.sendSuccess(id, { configOptions });
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
