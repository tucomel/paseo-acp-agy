import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ACPServer } from "../src/acp-server.js";
import { SessionManager } from "../src/session.js";

describe("ACP Cancellation & Interruption", () => {
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

  it("should handle session/cancel properly and abort active turn", async () => {
    const session = sessionManager.createSession({ cwd: "/tmp" });

    const cancelSpy = vi.spyOn(session.process, "cancelCurrentTurn").mockReturnValue(true);

    vi.spyOn(session.process, "sendPrompt").mockImplementation(
      async () => {
        // simulate delay then abort
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          event: "result",
          result: {
            conversation_id: "test-conv",
            status: "ERROR",
            response: "",
            error: "cancelled",
          },
        };
      }
    );

    // Send prompt
    sendRpc({
      jsonrpc: "2.0",
      id: 20,
      method: "session/prompt",
      params: {
        sessionId: session.id,
        prompt: "Run long task",
      },
    });

    // Immediately send cancel
    sendRpc({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: {
        sessionId: session.id,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(cancelSpy).toHaveBeenCalled();
    const promptResponse = responses.find((r) => r.id === 20);
    expect(promptResponse).toBeDefined();
    expect(promptResponse.result.stopReason).toBe("cancelled");
  });
});
