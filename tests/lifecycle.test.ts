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

    await new Promise((resolve) => setTimeout(resolve, 50));

    const res1 = responses.find((r) => r.id === 1);
    const res2 = responses.find((r) => r.id === 2);

    expect(res1).toBeDefined();
    expect(res2).toBeDefined();
    expect(res1.result.sessionId).not.toBe(res2.result.sessionId);

    const sessionA = sessionManager.getSession(res1.result.sessionId);
    const sessionB = sessionManager.getSession(res2.result.sessionId);

    expect(sessionA?.cwd).toBe("/tmp/workspace-a");
    expect(sessionA?.model).toBe("gemini-3.7-flash-high");

    expect(sessionB?.cwd).toBe("/tmp/workspace-b");
    expect(sessionB?.model).toBe("claude-sonnet-4-6");
  });

  it("should support set_mode and set_model", async () => {
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
      params: { sessionId: session.id, modelId: "gemini-3.1-pro-high" },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(session.mode).toBe("plan");
    expect(session.model).toBe("gemini-3.1-pro-high");
  });

  it("should close session and cleanup process on session/close", async () => {
    const session = sessionManager.createSession({ cwd: "/tmp" });
    const closeSpy = vi.spyOn(session, "close");

    sendRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "session/close",
      params: { sessionId: session.id },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closeSpy).toHaveBeenCalled();
    expect(sessionManager.getSession(session.id)).toBeUndefined();
  });
});
