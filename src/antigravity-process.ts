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

interface ActiveTurn {
  child: ChildProcess | null;
  cancelled: boolean;
  resolve: (result: AgyResultEvent) => void;
  reject: (err: Error) => void;
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
  private isClosed = false;
  private needsRestart = false;
  private transitionPromise: Promise<void> | null = null;
  private currentTurnPromise: ActiveTurn | null = null;

  public initialInfo: AgyInitEvent["init"] | null = null;

  constructor(options: AntigravityProcessOptions = {}) {
    super();
    this.binaryPath = options.binaryPath || process.env.AGY_BIN_PATH || "agy";
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.effort = options.effort;
    this.mode = options.mode;
    this.conversationId = options.conversationId;
    this.permissions = options.permissions || { sandbox: false, dangerouslySkipPermissions: false };
    this.env = { ...process.env, ...options.env };

    // EventEmitter treats "error" specially. Keep a defensive listener for
    // callers/tests that emit it directly; child failures use process_error.
    this.on("error", (err: Error) => {
      logger.error("AntigravityProcess error", { error: err.message });
    });
  }

  get isRunning(): boolean {
    const child = this.child;
    return child !== null && this.isProcessTreeAlive(child);
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
      this.scheduleRestart();
    }
  }

  setEffort(effort: string) {
    if (this.effort !== effort) {
      this.effort = effort;
      this.scheduleRestart();
    }
  }

  setMode(mode: string) {
    if (this.mode !== mode) {
      this.mode = mode;
      this.scheduleRestart();
    }
  }

  setConversationId(conversationId?: string) {
    if (this.conversationId !== conversationId) {
      this.conversationId = conversationId;
      this.scheduleRestart();
    }
  }

  private scheduleRestart() {
    if (!this.child) return;
    this.needsRestart = true;
    logger.info("Scheduled agy restart for updated session configuration", {
      model: this.model,
      effort: this.effort,
      mode: this.mode,
      conversationId: this.conversationId,
      turnActive: this.isExecutingTurn,
    });
  }

  private isProcessTreeAlive(child: ChildProcess): boolean {
    const pid = child.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return child.exitCode === null && child.signalCode === null;
  }

  private signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
    const pid = child.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
        logger.warn("Failed to signal agy process group; falling back to child PID", {
          pid,
          signal,
          error: (err as Error).message,
        });
      }
    }
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }

  private async waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessTreeAlive(child)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !this.isProcessTreeAlive(child);
  }

  private async terminateChild(child: ChildProcess, gracefulTimeoutMs = 2_000): Promise<void> {
    if (!this.isProcessTreeAlive(child)) {
      if (this.child === child) this.child = null;
      return;
    }

    this.signalProcessTree(child, "SIGTERM");
    if (!(await this.waitForProcessTreeExit(child, gracefulTimeoutMs))) {
      logger.warn("agy process tree did not exit after SIGTERM; sending SIGKILL", {
        pid: child.pid,
      });
      this.signalProcessTree(child, "SIGKILL");
      if (!(await this.waitForProcessTreeExit(child, 1_000))) {
        logger.error("agy process tree remained alive after SIGKILL", { pid: child.pid });
      }
    }

    if (this.child === child) this.child = null;
  }

  private async applyPendingRestart(owner?: ActiveTurn): Promise<void> {
    if (!this.needsRestart) return;
    if (this.currentTurnPromise && this.currentTurnPromise !== owner) {
      throw new Error("Cannot restart agy while another prompt turn is active");
    }
    if (owner?.child) {
      throw new Error("Cannot restart agy after the active turn has started executing");
    }
    if (!this.child) {
      this.needsRestart = false;
      return;
    }

    if (!this.transitionPromise) {
      const oldChild = this.child;
      this.transitionPromise = (async () => {
        logger.info("Restarting agy process with updated session configuration", {
          model: this.model,
          effort: this.effort,
          mode: this.mode,
          conversationId: this.conversationId,
        });
        await this.terminateChild(oldChild);
        this.initialInfo = null;
        this.needsRestart = false;
      })().finally(() => {
        this.transitionPromise = null;
      });
    }
    await this.transitionPromise;
  }

  async start(): Promise<void> {
    if (this.isClosed) throw new Error("Cannot start a closed Antigravity process");
    if (this.transitionPromise) await this.transitionPromise;
    if (this.isRunning) return;

    const extraArgs: string[] = [];
    if (this.model) extraArgs.push("--model", this.model);
    const effectiveEffort = getEffectiveEffortForModel(this.model, this.effort);
    if (effectiveEffort) extraArgs.push("--effort", effectiveEffort);
    if (this.conversationId) extraArgs.push("--conversation", this.conversationId);

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

    const child = spawn(this.binaryPath, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;

    if (!child.stdin || !child.stdout || !child.stderr) {
      if (this.child === child) this.child = null;
      this.signalProcessTree(child, "SIGKILL");
      throw new Error("Failed to create stdio pipes for agy process");
    }

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.handleEvent(JSON.parse(trimmed) as AgyIncomingEvent, child);
        } catch (err) {
          logger.warn("Failed to parse line from agy stdout", {
            line: trimmed,
            error: (err as Error).message,
          });
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) logger.warn("agy stderr: " + line.trim());
      }
    });

    child.on("error", (err: Error) => {
      logger.error("agy child process emitted error", { error: err.message });
      if (this.currentTurnPromise?.child === child) {
        this.currentTurnPromise.reject(err);
        this.currentTurnPromise = null;
      }
      this.emit("process_error", err);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      logger.info("agy process exited", { code, signal, pid: child.pid });
      if (this.currentTurnPromise?.child === child) {
        this.currentTurnPromise.reject(
          new Error(`agy process exited prematurely with code ${code} signal ${signal}`)
        );
        this.currentTurnPromise = null;
      }

      // The leader can die while a tool subprocess remains in its process
      // group. Keep the group identity long enough to reap those descendants.
      if (this.isProcessTreeAlive(child)) {
        void this.terminateChild(child).catch((err) => {
          logger.error("Failed to clean descendant processes after agy exit", {
            pid: child.pid,
            error: (err as Error).message,
          });
        });
      } else if (this.child === child) {
        this.child = null;
      }
      this.emit("exit", { code, signal, pid: child.pid });
    });
  }

  private handleEvent(event: AgyIncomingEvent, child: ChildProcess) {
    const ownsProcess = this.child === child;
    const ownsTurn = this.currentTurnPromise?.child === child;
    if (!ownsProcess && !ownsTurn) {
      logger.debug("Ignoring event from stale agy child", { event: event.event, pid: child.pid });
      return;
    }

    logger.debug("Received agy event", { event: event.event, pid: child.pid });
    switch (event.event) {
      case "init": {
        const initEvent = event as AgyInitEvent;
        if (ownsProcess && initEvent.conversation_id) {
          this.conversationId = initEvent.conversation_id;
          this.initialInfo = initEvent.init;
          this.emit("init", initEvent);
        }
        break;
      }
      case "step_update": {
        const stepEvent = event as AgyStepUpdateEvent;
        if (ownsProcess && stepEvent.step_update?.conversation_id) {
          this.conversationId = stepEvent.step_update.conversation_id;
        }
        if (ownsTurn) this.emit("step_update", stepEvent);
        break;
      }
      case "result": {
        if (!ownsTurn || !this.currentTurnPromise) break;
        const resultEvent = event as AgyResultEvent;
        if (resultEvent.result?.conversation_id) {
          this.conversationId = resultEvent.result.conversation_id;
        }
        this.emit("result", resultEvent);
        const active = this.currentTurnPromise;
        this.currentTurnPromise = null;
        active.resolve(resultEvent);
        break;
      }
      default:
        logger.warn("Unknown agy event received", { raw: event });
    }
  }

  async ensureReady(expectedConversationId?: string, timeoutMs = 10_000): Promise<void> {
    if (this.currentTurnPromise) {
      throw new Error("Cannot validate an Antigravity session while a prompt turn is active");
    }

    await this.applyPendingRestart();
    if (!this.isRunning) await this.start();

    const child = this.child;
    if (!child) throw new Error("Antigravity process failed to start");

    if (this.initialInfo !== null) {
      if (expectedConversationId && this.conversationId !== expectedConversationId) {
        const actual = this.conversationId;
        await this.terminateChild(child);
        this.conversationId = expectedConversationId;
        throw new Error(
          `Antigravity resumed unexpected conversation ${actual || "<none>"}; expected ${expectedConversationId}`
        );
      }
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.off("init", onInit);
        child.off("error", onError);
        child.off("close", onClose);
        clearTimeout(timer);
      };
      const finishReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onInit = (event: AgyInitEvent) => {
        if (this.child !== child) return;
        if (expectedConversationId && event.conversation_id !== expectedConversationId) {
          const actual = event.conversation_id;
          cleanup();
          settled = true;
          void this.terminateChild(child).finally(() => {
            this.conversationId = expectedConversationId;
            reject(
              new Error(
                `Antigravity resumed unexpected conversation ${actual}; expected ${expectedConversationId}`
              )
            );
          });
          return;
        }
        finishResolve();
      };
      const onError = (err: Error) => finishReject(err);
      const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
        finishReject(new Error(`Antigravity exited before initialization: code=${code} signal=${signal}`));
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        settled = true;
        void this.terminateChild(child).finally(() => {
          if (expectedConversationId) this.conversationId = expectedConversationId;
          reject(new Error(`Timed out waiting ${timeoutMs}ms for Antigravity initialization`));
        });
      }, timeoutMs);

      this.on("init", onInit);
      child.once("error", onError);
      child.once("close", onClose);

      if (this.initialInfo !== null) {
        onInit({
          event: "init",
          conversation_id: this.conversationId || "",
          init: this.initialInfo,
        });
      }
    });
  }

  async sendPrompt(
    text: string,
    onStepUpdate?: (event: AgyStepUpdateEvent) => void
  ): Promise<AgyResultEvent> {
    if (this.currentTurnPromise) {
      throw new Error("A prompt turn is already in progress on this session");
    }

    let resolveTurn!: (result: AgyResultEvent) => void;
    let rejectTurn!: (err: Error) => void;
    const turnPromise = new Promise<AgyResultEvent>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const active: ActiveTurn = {
      child: null,
      cancelled: false,
      resolve: resolveTurn,
      reject: rejectTurn,
    };

    // Reserve before the first await so concurrent prompt/cancel calls see the
    // turn while the child is still starting or restarting.
    this.currentTurnPromise = active;
    let stepListener: ((event: AgyStepUpdateEvent) => void) | null = null;

    const failBeforeWrite = (err: Error) => {
      if (stepListener) this.off("step_update", stepListener);
      if (this.currentTurnPromise === active) this.currentTurnPromise = null;
      active.reject(err);
    };

    try {
      await this.applyPendingRestart(active);
      if (active.cancelled) {
        failBeforeWrite(new Error("Prompt turn cancelled before execution"));
        return turnPromise;
      }

      if (!this.isRunning) await this.start();
      if (active.cancelled) {
        failBeforeWrite(new Error("Prompt turn cancelled before execution"));
        return turnPromise;
      }

      const child = this.child;
      if (!child || !child.stdin || !child.stdin.writable) {
        failBeforeWrite(new Error("Cannot send prompt: agy process stdin is not writable"));
        return turnPromise;
      }
      active.child = child;

      if (onStepUpdate) {
        stepListener = onStepUpdate;
        this.on("step_update", stepListener);
        const originalResolve = active.resolve;
        const originalReject = active.reject;
        active.resolve = (result) => {
          if (stepListener) this.off("step_update", stepListener);
          originalResolve(result);
        };
        active.reject = (err) => {
          if (stepListener) this.off("step_update", stepListener);
          originalReject(err);
        };
      }

      if (active.cancelled) {
        failBeforeWrite(new Error("Prompt turn cancelled before execution"));
        return turnPromise;
      }

      const payload: AgyStreamInputUserMessage = {
        event: "user",
        message: { content: text },
      };
      logger.debug("Writing prompt to agy stdin", { promptPreview: text.slice(0, 100) });
      child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      failBeforeWrite(err as Error);
    }

    return turnPromise;
  }

  cancelCurrentTurn(): boolean {
    const active = this.currentTurnPromise;
    if (!active) return false;

    active.cancelled = true;
    logger.info("Cancelling active agy turn", { hasChild: Boolean(active.child) });
    if (active.child) this.signalProcessTree(active.child, "SIGINT");
    return true;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.transitionPromise) await this.transitionPromise;

    const active = this.currentTurnPromise;
    if (active) {
      active.cancelled = true;
      this.currentTurnPromise = null;
      active.reject(new Error("Session closed while turn was in progress"));
    }

    const child = this.child;
    if (child) {
      try {
        await this.terminateChild(child);
      } catch (err) {
        logger.error("Error during agy process cleanup", { error: (err as Error).message });
      }
    }
  }
}
