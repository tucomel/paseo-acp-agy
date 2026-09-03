import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ACPServer } from "../src/acp-server.js";
import { SessionManager } from "../src/session.js";
import { SessionStore } from "../src/session-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ACP prompt-operation serialization", () => {
  it("blocks a second session/prompt while an async slash command is running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-slash-lock-"));
    tempDirs.push(dir);
    const fakeAgy = path.join(dir, "fake-agy.mjs");
    fs.writeFileSync(
      fakeAgy,
      `#!/usr/bin/env node\n` +
        `const args = process.argv.slice(2);\n` +
        `if (args.includes("--print") && args.includes("/usage")) {\n` +
        `  setTimeout(() => { console.log("Gemini Models\\tWeekly Limit Remaining\\t100%\\t2026-09-09T06:10:04Z"); }, 150);\n` +
        `} else { process.exit(0); }\n`,
      { mode: 0o700 }
    );

    const input = new PassThrough();
    const output = new PassThrough();
    const responses: any[] = [];
    output.setEncoding("utf8");
    let buffer = "";
    output.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    const store = new SessionStore(path.join(dir, "sessions"));
    const manager = new SessionManager({ store, defaultBinaryPath: fakeAgy });
    const session = manager.createSession({ cwd: dir, binaryPath: fakeAgy });
    const server = new ACPServer({ input, output, sessionManager: manager, binaryPath: fakeAgy });
    server.start();

    const send = (msg: unknown) => input.write(JSON.stringify(msg) + "\n");
    const waitForResponse = async (id: number, timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = responses.find((entry) => entry.id === id);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for response ${id}`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: session.id, prompt: "/usage" },
    });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: session.id, prompt: "second prompt" },
    });

    const second = await waitForResponse(2);
    expect(second.error?.code).toBe(-32000);
    expect(second.error?.message).toContain("prompt operation");

    const first = await waitForResponse(1);
    expect(first.result?.stopReason).toBe("end_turn");
    expect(session.isPromptOperationActive).toBe(false);

    await server.stop();
  });
});
