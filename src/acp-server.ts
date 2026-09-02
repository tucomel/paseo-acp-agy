import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { logger } from "./logger.js";
import {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  ACP_METHODS,
  AVAILABLE_MODELS,
  AVAILABLE_MODES,
  extractPromptText,
  mapToolNameToKind,
  AgyStepUpdateEvent,
  AgyResultEvent,
} from "./protocol.js";
import { SessionManager, Session } from "./session.js";

export class ACPServer {
  private sessionManager: SessionManager;
  private input: Readable;
  private output: Writable;
  private rl: readline.Interface | null = null;
  private isRunning: boolean = false;

  constructor(options: {
    input?: Readable;
    output?: Writable;
    sessionManager?: SessionManager;
  } = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.sessionManager = options.sessionManager || new SessionManager();
  }

  start() {
    if (this.isRunning) {
      return;
    }
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
    const serialized = JSON.stringify(msg) + "\n";
    this.output.write(serialized);
  }

  private sendNotification(method: string, params: unknown) {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.send(notification);
  }

  private sendSuccess(id: string | number, result: unknown) {
    const response: JsonRpcSuccessResponse = {
      jsonrpc: "2.0",
      id,
      result,
    };
    this.send(response);
  }

  private sendError(id: string | number | null, code: number, message: string, data?: unknown) {
    const response: JsonRpcErrorResponse = {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    };
    this.send(response);
  }

  private async handleLine(rawLine: string) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      logger.warn("Invalid JSON received on ACP stdio", { line: trimmed });
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
              serverInfo: {
                name: "agy-acp",
                version: "1.0.0",
              },
              agentCapabilities: {
                loadSession: false,
                sessionCapabilities: {},
              },
            });
          }
          break;
        }

        case ACP_METHODS.SESSION_NEW:
        case ACP_METHODS.SESSION_NEW_ALIAS: {
          const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
          const model = typeof params.model === "string" ? params.model : undefined;
          const mode = typeof params.mode === "string" ? params.mode : undefined;

          const session = this.sessionManager.createSession({ cwd, model, mode });

          if (!isNotification) {
            this.sendSuccess(id, {
              sessionId: session.id,
              modes: {
                availableModes: AVAILABLE_MODES,
                currentModeId: session.mode,
              },
              models: {
                availableModels: AVAILABLE_MODELS,
                currentModelId: session.model,
              },
            });
          }
          break;
        }

        case ACP_METHODS.SESSION_PROMPT:
        case ACP_METHODS.SESSION_PROMPT_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const session = this.sessionManager.getSession(sessionId);

          if (!session) {
            if (!isNotification) {
              this.sendError(id, -32602, `Session not found: ${sessionId}`);
            }
            return;
          }

          session.touch();
          const promptText = extractPromptText(params.prompt);

          logger.info("Processing ACP prompt", { sessionId, promptLength: promptText.length });

          const onStepUpdate = (event: AgyStepUpdateEvent) => {
            const step = event.step_update;
            if (!step) {
              return;
            }

            if (step.step_type === "agent_response") {
              if (step.text_delta) {
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: step.text_delta,
                    },
                  },
                });
              }
            } else if (step.step_type === "thought") {
              if (step.text_delta) {
                this.sendNotification(ACP_METHODS.SESSION_UPDATE, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: {
                      type: "text",
                      text: step.text_delta,
                    },
                  },
                });
              }
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

            const status = resultEvent.result?.status;
            const stopReason = status === "SUCCESS" ? "end_turn" : "cancelled";

            if (!isNotification) {
              this.sendSuccess(id, {
                stopReason,
              });
            }
          } catch (promptErr) {
            logger.error("Error executing prompt turn", { error: (promptErr as Error).message });
            if (!isNotification) {
              this.sendSuccess(id, {
                stopReason: "cancelled",
              });
            }
          }
          break;
        }

        case ACP_METHODS.SESSION_CANCEL:
        case ACP_METHODS.SESSION_CANCEL_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const session = this.sessionManager.getSession(sessionId);
          if (session) {
            logger.info("Cancelling session prompt", { sessionId });
            session.process.cancelCurrentTurn();
          }
          if (!isNotification) {
            this.sendSuccess(id, {});
          }
          break;
        }

        case ACP_METHODS.SESSION_CLOSE:
        case ACP_METHODS.SESSION_CLOSE_ALIAS: {
          const sessionId = String(params.sessionId || "");
          await this.sessionManager.closeSession(sessionId);
          if (!isNotification) {
            this.sendSuccess(id, {});
          }
          break;
        }

        case ACP_METHODS.SESSION_SET_MODE:
        case ACP_METHODS.SESSION_SET_MODE_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const modeId = String(params.modeId || params.mode || "default");
          const session = this.sessionManager.getSession(sessionId);
          if (session) {
            session.mode = modeId;
          }
          if (!isNotification) {
            this.sendSuccess(id, {});
          }
          break;
        }

        case ACP_METHODS.SESSION_SET_MODEL:
        case ACP_METHODS.SESSION_SET_MODEL_ALIAS: {
          const sessionId = String(params.sessionId || "");
          const modelId = String(params.modelId || params.model || "");
          const session = this.sessionManager.getSession(sessionId);
          if (session && modelId) {
            session.model = modelId;
          }
          if (!isNotification) {
            this.sendSuccess(id, {});
          }
          break;
        }

        default:
          if (!isNotification) {
            this.sendError(id, -32601, `Method not found: ${method}`);
          }
          break;
      }
    } catch (handlerErr) {
      logger.error("Internal handler error", { method, error: (handlerErr as Error).message });
      if (!isNotification) {
        this.sendError(id, -32603, "Internal error: " + (handlerErr as Error).message);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    await this.sessionManager.closeAll();
    logger.info("ACP Server stopped");
  }
}
