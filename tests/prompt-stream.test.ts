import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ACPServer } from "../src/acp-server.js";
import { SessionManager } from "../src/session.js";
import { AgyResultEvent, AgyStepUpdateEvent } from "../src/protocol.js";

describe("ACP Prompt Streaming & Tool Call Translation", () => {
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

  it("should stream agent message chunks and tool calls properly", async () => {
    // 1. Create a session
    const session = sessionManager.createSession({ cwd: "/tmp" });

    // Mock sendPrompt on the session process
    vi.spyOn(session.process, "sendPrompt").mockImplementation(
      async (text: string, onStepUpdate?: (event: AgyStepUpdateEvent) => void): Promise<AgyResultEvent> => {
        if (onStepUpdate) {
          // Send agent response chunk
          onStepUpdate({
            event: "step_update",
            step_update: {
              conversation_id: "test-conv",
              step_index: 1,
              state: "ACTIVE",
              step_type: "agent_response",
              text_delta: "Hello from Antigravity!",
            },
          });

          // Send tool active step
          onStepUpdate({
            event: "step_update",
            step_update: {
              conversation_id: "test-conv",
              step_index: 2,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "view_file",
              tool_info: {
                name: "view_file",
                parameters: { AbsolutePath: "/tmp/test.txt" },
              },
            },
          });

          // Send tool done step
          onStepUpdate({
            event: "step_update",
            step_update: {
              conversation_id: "test-conv",
              step_index: 2,
              state: "DONE",
              step_type: "tool",
              tool_name: "view_file",
              tool_info: {
                name: "view_file",
                output: "File contents here",
              },
            },
          });
        }

        return {
          event: "result",
          result: {
            conversation_id: "test-conv",
            status: "SUCCESS",
            response: "Hello from Antigravity!",
            duration_seconds: 1.0,
            num_turns: 1,
          },
        };
      }
    );

    // Send prompt request
    sendRpc({
      jsonrpc: "2.0",
      id: 10,
      method: "session/prompt",
      params: {
        sessionId: session.id,
        prompt: [{ type: "text", text: "Say hello and read file" }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check notifications
    const notifications = responses.filter((r) => r.method === "session/update");
    expect(notifications.length).toBeGreaterThanOrEqual(3);

    // Verify agent message chunk
    const msgChunk = notifications.find(
      (n) => n.params.update.sessionUpdate === "agent_message_chunk"
    );
    expect(msgChunk).toBeDefined();
    expect(msgChunk.params.update.content.text).toBe("Hello from Antigravity!");

    // Verify tool call
    const toolCall = notifications.find((n) => n.params.update.sessionUpdate === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall.params.update.title).toBe("view_file");
    expect(toolCall.params.update.kind).toBe("read");

    // Verify tool call update
    const toolCallUpdate = notifications.find(
      (n) => n.params.update.sessionUpdate === "tool_call_update"
    );
    expect(toolCallUpdate).toBeDefined();
    expect(toolCallUpdate.params.update.status).toBe("completed");

    // Check prompt response
    const promptResponse = responses.find((r) => r.id === 10);
    expect(promptResponse).toBeDefined();
    expect(promptResponse.result.stopReason).toBe("end_turn");
  });
});
