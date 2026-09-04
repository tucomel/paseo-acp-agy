import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ACPServer } from "../src/acp-server.js";
import { SessionManager } from "../src/session.js";

describe("ACP Session Lifecycle & Isolation", () => {
  let server: ACPServer;
  let clientInput: PassThrough;
  let clientOutput: PassThrough;
  let responses: any[];
  let sessionManager: SessionManager;

  beforeEach(() => {
    clientInput = new PassThrough();
    clientOutput = new PassThrough();
    responses = [];

    clientOutput.setEncoding("utf-8");
    clientOutput.on("data", (chunk: string) => {
      const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        responses.push(JSON.parse(line));
      }
    });

    sessionManager = new SessionManager();
    server = new ACPServer({
      input: clientInput,
      output: clientOutput,
      sessionManager,
    });
    server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function sendRpc(msg: any) {
    clientInput.write(JSON.stringify(msg) + "\n");
  }

  async function waitForResponse(id: number, timeoutMs = 15000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = responses.find((r) => r.id === id);
      if (res) return res;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timeout waiting for RPC response id=${id}`);
  }

  it("should isolate multiple sessions independently", async () => {
    sendRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/workspace-a", model: "gemini-3.7-flash-high" },
    });

    sendRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/tmp/workspace-b", model: "claude-sonnet-4-6" },
    });

    const res1 = await waitForResponse(1);
    const res2 = await waitForResponse(2);

    expect(res1).toBeDefined();
    expect(res2).toBeDefined();
    expect(res1.result.sessionId).not.toBe(res2.result.sessionId);

    const sessionA = sessionManager.getSession(res1.result.sessionId);
    const sessionB = sessionManager.getSession(res2.result.sessionId);

    expect(sessionA?.cwd).toBe("/tmp/workspace-a");
    expect(sessionA?.model).toBe("gemini-3.7-flash");
    expect(sessionA?.effort).toBe("high");

    expect(sessionB?.cwd).toBe("/tmp/workspace-b");
    expect(sessionB?.model).toBe("claude-sonnet-4-6");
    expect(sessionB?.effort).toBe("high");
  });

  it("should support set_mode, set_model, and set_config_option (thought_level) and update process", async () => {
    const session = sessionManager.createSession({ cwd: "/tmp" });

    sendRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { sessionId: session.id, modeId: "plan" },
    });

    sendRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_model",
      params: { sessionId: session.id, modelId: "gemini-3.7-flash" },
    });

    sendRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "session/set_config_option",
      params: { sessionId: session.id, configId: "thought_level", value: "low" },
    });

    const res3 = await waitForResponse(3);
    const res4 = await waitForResponse(4);
    const res5 = await waitForResponse(5);

    expect(res3).toBeDefined();
    expect(res4).toBeDefined();
    expect(res5).toBeDefined();

    expect(session.mode).toBe("plan");
    expect(session.model).toBe("gemini-3.7-flash");
    expect(session.effort).toBe("low");

    expect(session.process.currentMode).toBe("plan");
    expect(session.process.currentModel).toBe("gemini-3.7-flash");
    expect(session.process.currentEffort).toBe("low");

    expect(res5.result.configOptions).toBeDefined();
    expect(res5.result.configOptions[0].currentValue).toBe("low");
  });

  it("should safely handle process errors without throwing unhandled exceptions", () => {
    const session = sessionManager.createSession({ cwd: "/tmp" });
    expect(() => {
      session.process.emit("error", new Error("Simulated subprocess failure"));
    }).not.toThrow();
  });

  it("should close session and cleanup process on session/close", async () => {
    const session = sessionManager.createSession({ cwd: "/tmp" });
    const closeSpy = vi.spyOn(session, "close");

    sendRpc({
      jsonrpc: "2.0",
      id: 6,
      method: "session/close",
      params: { sessionId: session.id },
    });

    await waitForResponse(6);

    expect(closeSpy).toHaveBeenCalled();
    expect(sessionManager.getSession(session.id)).toBeUndefined();
  });
});
