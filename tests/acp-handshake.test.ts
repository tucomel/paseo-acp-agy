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
      for (const line of chunk.split("\n").filter((value) => value.trim())) {
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
      const response = responses.find((item) => item.id === id);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timeout waiting for RPC response id=${id}`);
  }

  it("advertises resume without falsely advertising loadSession replay", async () => {
    sendRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "1.0.0",
        clientInfo: { name: "paseo", version: "0.7.2" },
      },
    });

    const response = await waitForResponse(1);
    expect(response.result.serverInfo.name).toBe("agy-acp");
    expect(response.result.serverInfo.version).toBe("1.0.0");
    expect(response.result.protocolVersion).toBe("1.0.0");
    expect(response.result.agentCapabilities.loadSession).toBe(false);
    expect(response.result.agentCapabilities.sessionCapabilities.resume).toBe(true);
  });

  it("returns session state and command metadata from session/new", async () => {
    sendRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        cwd: "/home/ubuntu/projects/eo",
        model: "gemini-3.7-flash-high",
      },
    });

    const response = await waitForResponse(2);
    expect(response.result.sessionId).toBeDefined();
    expect(response.result.modes.availableModes.length).toBeGreaterThan(0);
    expect(response.result.models.availableModels.length).toBeGreaterThan(0);
    expect(response.result.configOptions[0].category).toBe("thought_level");

    const commands = responses.find(
      (item) => item.method === "session/update" && item.params?.update?.sessionUpdate === "available_commands_update"
    );
    expect(commands).toBeDefined();
  });

  it("rejects session/load until history replay is implemented", async () => {
    sendRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "session/load",
      params: { sessionId: "anything", cwd: "/tmp", mcpServers: [] },
    });
    const response = await waitForResponse(3);
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain("session/load");
  });

  it("returns method not found for unknown methods", async () => {
    sendRpc({ jsonrpc: "2.0", id: 99, method: "unknown/method", params: {} });
    const response = await waitForResponse(99);
    expect(response.error.code).toBe(-32601);
  });
});
