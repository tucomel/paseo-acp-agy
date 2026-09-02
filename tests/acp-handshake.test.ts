import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { ACPServer } from "../src/acp-server.js";
import { SessionManager } from "../src/session.js";

describe("ACP Handshake & Protocol", () => {
  let server: ACPServer;
  let clientInput: PassThrough;
  let clientOutput: PassThrough;
  let responses: any[];

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

    server = new ACPServer({
      input: clientInput,
      output: clientOutput,
      sessionManager: new SessionManager(),
    });
    server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function sendRpc(msg: any) {
    clientInput.write(JSON.stringify(msg) + "\n");
  }

  async function waitForResponse(id: number, timeoutMs = 2000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = responses.find((r) => r.id === id);
      if (res) return res;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timeout waiting for RPC response id=${id}`);
  }

  it("should respond to initialize with server capabilities and info", async () => {
    sendRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "1.0.0",
        clientInfo: { name: "paseo", version: "0.7.2" },
      },
    });

    const res = await waitForResponse(1);
    expect(res.id).toBe(1);
    expect(res.jsonrpc).toBe("2.0");
    expect(res.result.serverInfo.name).toBe("agy-acp");
    expect(res.result.serverInfo.version).toBe("1.0.0");
    expect(res.result.protocolVersion).toBe("1.0.0");
    expect(res.result.agentCapabilities.loadSession).toBe(true);
    expect(res.result.agentCapabilities.sessionCapabilities.resume).toBe(true);
  });

  it("should respond to session/new with new session ID and available modes/models", async () => {
    sendRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        cwd: "/home/ubuntu/projects/eo",
        model: "gemini-3.7-flash-high",
      },
    });

    const res = await waitForResponse(2);
    expect(res.id).toBe(2);
    expect(res.result.sessionId).toBeDefined();
    expect(res.result.modes.availableModes.length).toBeGreaterThan(0);
    expect(res.result.models.availableModels.length).toBeGreaterThan(0);
    expect(res.result.configOptions).toBeDefined();
    expect(res.result.configOptions[0].category).toBe("thought_level");
  });

  it("should return method not found for unknown methods", async () => {
    sendRpc({
      jsonrpc: "2.0",
      id: 99,
      method: "unknown/method",
      params: {},
    });

    const res = await waitForResponse(99);
    expect(res.id).toBe(99);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32601);
  });
});
