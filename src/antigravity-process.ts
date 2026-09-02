import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "./logger.js";
import {
  AgyIncomingEvent,
  AgyInitEvent,
  AgyStepUpdateEvent,
  AgyResultEvent,
  AgyStreamInputUserMessage,
  getEffectiveEffortForModel,
} from "./protocol.js";
import { buildAgyArgs, PermissionSettings } from "./permissions.js";

export interface AntigravityProcessOptions {
  binaryPath?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  mode?: string;
  conversationId?: string;
  permissions?: PermissionSettings;
  env?: Record<string, string>;
}

export class AntigravityProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private binaryPath: string;
  private cwd: string;
  private model?: string;
  private effort?: string;
  private mode?: string;
  private conversationId?: string;
  private permissions: PermissionSettings;
  private env: NodeJS.ProcessEnv;
  private stdoutBuffer: string = "";
  private stderrBuffer: string = "";
  private isClosed: boolean = false;
  private needsRestart: boolean = false;
  private currentTurnPromise: {
    resolve: (result: AgyResultEvent) => void;
    reject: (err: Error) => void;
  } | null = null;

  public initialInfo: AgyInitEvent["init"] | null = null;

  constructor(options: AntigravityProcessOptions = {}) {
    super();
    this.on("error", (err) => {
      logger.error("AntigravityProcess internal error event", { error: err.message });
    });

    this.binaryPath = options.binaryPath || process.env.AGY_BIN_PATH || "agy";
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.effort = options.effort;
    this.mode = options.mode;
    this.conversationId = options.conversationId;
    this.permissions = options.permissions || { sandbox: false, dangerouslySkipPermissions: false };
    this.env = { ...process.env, ...options.env };
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }

  get isExecutingTurn(): boolean {
    return this.currentTurnPromise !== null;
  }

  get currentConversationId(): string | undefined {
    return this.conversationId;
  }

  get currentModel(): string | undefined {
    return this.model;
  }

  get currentEffort(): string | undefined {
    return this.effort;
  }

  get currentMode(): string | undefined {
    return this.mode;
  }

  setModel(model: string) {
    if (this.model !== model) {
      this.model = model;
      this.reconfigureOrScheduleRestart();
    }
  }

  setEffort(effort: string) {
    if (this.effort !== effort) {
      this.effort = effort;
      this.reconfigureOrScheduleRestart();
    }
  }

  setMode(mode: string) {
    if (this.mode !== mode) {
      this.mode = mode;
      this.reconfigureOrScheduleRestart();
    }
  }

  private reconfigureOrScheduleRestart() {
    if (!this.isRunning) {
      return;
    }
    if (this.isExecutingTurn) {
      this.needsRestart = true;
    } else {
      logger.info("Reconfiguring agy process with new settings (model/effort/mode)", {
        model: this.model,
        effort: this.effort,
        mode: this.mode,
        conversationId: this.conversationId,
      });
      this.killChildGracefully();
    }
  }

  private killChildGracefully() {
    if (this.child) {
      try {
        if (this.child.stdin && !this.child.stdin.destroyed) {
          this.child.stdin.end();
        }
        if (this.isRunning) {
          this.child.kill("SIGTERM");
        }
      } catch {
        // ignore kill errors
      }
      this.child = null;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    const extraArgs: string[] = [];
    if (this.model) {
      extraArgs.push("--model", this.model);
    }

    const effectiveEffort = getEffectiveEffortForModel(this.model, this.effort);
    if (effectiveEffort) {
      extraArgs.push("--effort", effectiveEffort);
    }

    if (this.conversationId) {
      extraArgs.push("--conversation", this.conversationId);
    }

    const args = buildAgyArgs(
      {
        sandbox: this.permissions.sandbox,
        dangerouslySkipPermissions: this.permissions.dangerouslySkipPermissions,
        mode: this.mode,
      },
      extraArgs
    );

    logger.info("Spawning agy process", {
      binary: this.binaryPath,
      args,
      cwd: this.cwd,
      effectiveEffort,
    });

    try {
      this.child = spawn(this.binaryPath, args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (spawnErr) {
      logger.error("Failed to spawn agy process", { error: (spawnErr as Error).message });
      throw spawnErr;
    }

    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) {
      throw new Error("Failed to create stdio pipes for agy process");
    }

    this.child.stdout.setEncoding("utf-8");
    this.child.stderr.setEncoding("utf-8");

    this.child.stdout.on("data", (chunk: string) => {
      this.handleStdoutData(chunk);
    });

    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      const lines = this.stderrBuffer.split("\n");
      this.stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          logger.warn("agy stderr: " + line.trim());
        }
      }
    });

    this.child.on("error", (err: Error) => {
      logger.error("agy child process emitted error", { error: err.message });
      if (this.currentTurnPromise) {
        this.currentTurnPromise.reject(err);
        this.currentTurnPromise = null;
      }
      this.emit("process_error", err);
    });

    this.child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      logger.info("agy process exited", { code, signal });
      this.child = null;

      if (this.currentTurnPromise) {
        const errorMsg = `agy process exited prematurely with code ${code} signal ${signal}`;
        this.currentTurnPromise.reject(new Error(errorMsg));
        this.currentTurnPromise = null;
      }

      this.emit("exit", { code, signal });
    });
  }

  private handleStdoutData(chunk: string) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const event = JSON.parse(trimmed) as AgyIncomingEvent;
        this.handleEvent(event);
      } catch (err) {
        logger.warn("Failed to parse line from agy stdout", {
          line: trimmed,
          error: (err as Error).message,
        });
      }
    }
  }

  private handleEvent(event: AgyIncomingEvent) {
    logger.debug("Received agy event", { event: event.event });

    switch (event.event) {
      case "init": {
        const initEvent = event as AgyInitEvent;
        if (initEvent.conversation_id) {
          this.conversationId = initEvent.conversation_id;
        }
        this.initialInfo = initEvent.init;
        this.emit("init", initEvent);
        break;
      }

      case "step_update": {
        const stepEvent = event as AgyStepUpdateEvent;
        if (stepEvent.step_update?.conversation_id) {
          this.conversationId = stepEvent.step_update.conversation_id;
        }
        this.emit("step_update", stepEvent);
        break;
      }

      case "result": {
        const resultEvent = event as AgyResultEvent;
        if (resultEvent.result?.conversation_id) {
          this.conversationId = resultEvent.result.conversation_id;
        }
        this.emit("result", resultEvent);

        if (this.currentTurnPromise) {
          const { resolve } = this.currentTurnPromise;
          this.currentTurnPromise = null;
          resolve(resultEvent);
        }
        break;
      }

      default:
        logger.warn("Unknown agy event received", { raw: event });
        break;
    }
  }

  async sendPrompt(
    text: string,
    onStepUpdate?: (event: AgyStepUpdateEvent) => void
  ): Promise<AgyResultEvent> {
    if (this.needsRestart && this.isRunning) {
      this.needsRestart = false;
      this.killChildGracefully();
    }

    if (!this.isRunning) {
      await this.start();
    }

    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      throw new Error("Cannot send prompt: agy process stdin is not writable");
    }

    if (this.currentTurnPromise) {
      throw new Error("A prompt turn is already in progress on this session");
    }

    const payload: AgyStreamInputUserMessage = {
      event: "user",
      message: {
        content: text,
      },
    };

    let stepListener: ((event: AgyStepUpdateEvent) => void) | null = null;
    if (onStepUpdate) {
      stepListener = onStepUpdate;
      this.on("step_update", stepListener);
    }

    const line = JSON.stringify(payload) + "\n";
    logger.debug("Writing prompt to agy stdin", { promptPreview: text.slice(0, 100) });

    return new Promise<AgyResultEvent>((resolve, reject) => {
      this.currentTurnPromise = {
        resolve: (res) => {
          if (stepListener) {
            this.off("step_update", stepListener);
          }
          resolve(res);
        },
        reject: (err) => {
          if (stepListener) {
            this.off("step_update", stepListener);
          }
          reject(err);
        },
      };

      try {
        this.child!.stdin!.write(line);
      } catch (err) {
        if (stepListener) {
          this.off("step_update", stepListener);
        }
        this.currentTurnPromise = null;
        reject(err);
      }
    });
  }

  cancelCurrentTurn(): boolean {
    if (!this.currentTurnPromise || !this.isRunning) {
      return false;
    }

    logger.info("Cancelling active agy turn via SIGINT");
    try {
      if (this.child) {
        this.child.kill("SIGINT");
      }
      return true;
    } catch (err) {
      logger.error("Failed to send SIGINT to agy process", { error: (err as Error).message });
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    if (this.currentTurnPromise) {
      this.currentTurnPromise.reject(new Error("Session closed while turn was in progress"));
      this.currentTurnPromise = null;
    }

    if (this.child) {
      try {
        if (this.child.stdin && !this.child.stdin.destroyed) {
          this.child.stdin.end();
        }
        if (this.isRunning) {
          this.child.kill("SIGTERM");
          setTimeout(() => {
            if (this.isRunning) {
              this.child?.kill("SIGKILL");
            }
          }, 2000);
        }
      } catch (err) {
        logger.error("Error during agy process cleanup", { error: (err as Error).message });
      }
    }
  }
}
