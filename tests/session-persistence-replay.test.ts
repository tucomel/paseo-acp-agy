import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACPServer } from "../src/acp-server.js";
import { SessionManager } from "../src/session.js";
import { SessionStore } from "../src/session-store.js";
import { extractCleanUserPrompt } from "../src/transcript.js";

describe("ACP Session History Replay, Listing & Auto-Healing", () => {
  let server: ACPServer;
  let clientInput: PassThrough;
  let clientOutput: PassThrough;
  let responses: any[];
  let sessionManager: SessionManager;
  let tempDir: string;
  let tempBrainDir: string;
  let originalBrainDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-sessions-"));
    tempBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-brain-"));
    originalBrainDir = process.env.AGY_BRAIN_DIR;
    process.env.AGY_BRAIN_DIR = tempBrainDir;

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

    const customStore = new SessionStore(path.join(tempDir, "sessions"));
    sessionManager = new SessionManager({ store: customStore });
    server = new ACPServer({
      input: clientInput,
      output: clientOutput,
      sessionManager,
    });
    server.start();
  });

  afterEach(async () => {
    await server.stop();
    if (originalBrainDir !== undefined) {
      process.env.AGY_BRAIN_DIR = originalBrainDir;
    } else {
      delete process.env.AGY_BRAIN_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempBrainDir, { recursive: true, force: true });
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

  it("extracts clean prompt removing USER_REQUEST xml tags", () => {
    const raw = `<USER_REQUEST>\nFix the crash in the ACP server\n</USER_REQUEST>`;
    expect(extractCleanUserPrompt(raw)).toBe("Fix the crash in the ACP server");
  });

  it("lists sessions via session/list including title and cwd", async () => {
    const s1 = sessionManager.createSession({ cwd: "/workspace/proj-a" });
    s1.setTitle("Project A Tasks");

    const s2 = sessionManager.createSession({ cwd: "/workspace/proj-b" });
    s2.setTitle("Project B Optimization");

    sendRpc({
      jsonrpc: "2.0",
      id: 101,
      method: "session/list",
      params: {},
    });

    const res = await waitForResponse(101);
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result.sessions)).toBe(true);
    expect(res.result.sessions.length).toBe(2);

    const titles = res.result.sessions.map((s: any) => s.title);
    expect(titles).toContain("Project A Tasks");
    expect(titles).toContain("Project B Optimization");

    // Filter by cwd
    sendRpc({
      jsonrpc: "2.0",
      id: 102,
      method: "session/list",
      params: { cwd: "/workspace/proj-a" },
    });

    const resFiltered = await waitForResponse(102);
    expect(resFiltered.result.sessions.length).toBe(1);
    expect(resFiltered.result.sessions[0].sessionId).toBe(s1.id);
  });

  it("replays conversation history via session/update notifications when loading session", async () => {
    const convId = "conv-replay-123";
    const session = sessionManager.createSession({
      cwd: "/workspace/demo",
      conversationId: convId,
    });

    // Create a mock brain transcript file
    const convLogDir = path.join(tempBrainDir, convId, ".system_generated", "logs");
    fs.mkdirSync(convLogDir, { recursive: true });

    const transcriptLines = [
      JSON.stringify({
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "<USER_REQUEST>\nShow me git status\n</USER_REQUEST>",
      }),
      JSON.stringify({
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        thinking: "Let me run git status using terminal",
        tool_calls: [
          {
            toolAction: "Checking git status",
            toolSummary: "Git status check",
            parameters: { CommandLine: "git status" },
          },
        ],
      }),
      JSON.stringify({
        source: "GENERIC",
        type: "GENERIC",
        content: "On branch master\nnothing to commit",
      }),
      JSON.stringify({
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        content: "Git status shows the working tree is clean.",
      }),
    ];
    fs.writeFileSync(path.join(convLogDir, "transcript.jsonl"), transcriptLines.join("\n") + "\n");

    sendRpc({
      jsonrpc: "2.0",
      id: 201,
      method: "session/load",
      params: { sessionId: session.id },
    });

    const res = await waitForResponse(201);
    expect(res.result).toBeDefined();
    expect(res.result.sessionId).toBe(session.id);

    // Verify session title was auto-extracted from first prompt
    expect(session.title).toBe("Show me git status");

    // Verify replayed notifications
    const updates = responses.filter(
      (item) => item.method === "session/update" && item.params?.sessionId === session.id
    );

    const userChunks = updates.filter((u) => u.params.update.sessionUpdate === "user_message_chunk");
    expect(userChunks.length).toBeGreaterThan(0);
    expect(userChunks[0].params.update.content.text).toBe("Show me git status");

    const thoughts = updates.filter((u) => u.params.update.sessionUpdate === "agent_thought_chunk");
    expect(thoughts.length).toBeGreaterThan(0);
    expect(thoughts[0].params.update.content.text).toContain("Let me run git status");

    const toolCalls = updates.filter((u) => u.params.update.sessionUpdate === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolCalls[0].params.update.title).toBe("Git status check");

    const toolUpdates = updates.filter((u) => u.params.update.sessionUpdate === "tool_call_update");
    expect(toolUpdates.length).toBeGreaterThan(0);
    expect(toolUpdates[0].params.update.status).toBe("completed");
    expect(toolUpdates[0].params.update.rawOutput).toBe("On branch master\nnothing to commit");

    const agentChunks = updates.filter((u) => u.params.update.sessionUpdate === "agent_message_chunk");
    expect(agentChunks.length).toBeGreaterThan(0);
    expect(agentChunks[0].params.update.content.text).toBe("Git status shows the working tree is clean.");
  }, 30000);

  it("forks session copying configuration and title suffix", async () => {
    const parent = sessionManager.createSession({
      cwd: "/workspace/fork-test",
      model: "claude-sonnet-4-6",
      effort: "medium",
      mode: "code",
    });
    parent.setTitle("Base Feature");

    sendRpc({
      jsonrpc: "2.0",
      id: 301,
      method: "session/fork",
      params: { sessionId: parent.id },
    });

    const res = await waitForResponse(301);
    expect(res.result).toBeDefined();
    expect(res.result.sessionId).not.toBe(parent.id);

    const forked = sessionManager.getSession(res.result.sessionId);
    expect(forked).toBeDefined();
    expect(forked?.title).toBe("Base Feature (fork)");
    expect(forked?.model).toBe("claude-sonnet-4-6");
    expect(forked?.effort).toBe("medium");
    expect(forked?.mode).toBe("code");
  }, 30000);

  it("auto-heals when resuming a broken conversation ID", async () => {
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-autoheal-"));
    const fakeBinary = path.join(fakeDir, "fake-agy.mjs");
    fs.writeFileSync(
      fakeBinary,
      `#!/usr/bin/env node
const convIdx = process.argv.indexOf("--conversation");
if (convIdx >= 0 && process.argv[convIdx + 1] === "bad-conv") {
  process.stderr.write("Error: conversation corrupted or interrupted\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  event: "init",
  conversation_id: "fresh-healed-conv",
  init: { model: "fake" }
}) + "\\n");
process.stdin.resume();
`,
      { mode: 0o755 }
    );

    const { AntigravityProcess } = await import("../src/antigravity-process.js");
    const proc = new AntigravityProcess({
      binaryPath: fakeBinary,
      conversationId: "bad-conv",
    });

    let healed = false;
    proc.on("conversation_healed", () => {
      healed = true;
    });

    await proc.ensureReady("bad-conv", 5000, undefined, true);

    expect(healed).toBe(true);
    expect(proc.currentConversationId).toBe("fresh-healed-conv");
    expect(proc.isRunning).toBe(true);

    await proc.close();
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }, 15000);
});
