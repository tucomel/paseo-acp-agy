import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  calculateUsageCostUsd,
  getModelContextWindow,
  parseAgyQuotaOutput,
  parseAgyCreditsOutput,
  deriveUsageTone,
  fetchAntigravityUsage,
} from "../src/protocol.js";
import { ACPServer } from "../src/acp-server.js";
import { SessionManager } from "../src/session.js";
import { SessionStore } from "../src/session-store.js";

function makeRpcHarness(manager: SessionManager) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: any[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });

  const server = new ACPServer({ input, output, sessionManager: manager });
  server.start();
  const send = (message: unknown) => input.write(JSON.stringify(message) + "\n");
  const waitForResponse = async (id: number, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = messages.find((message) => message.id === id);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for RPC response ${id}`);
  };

  return { server, send, waitForResponse, messages };
}

describe("Usage, Context Window & Pricing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-usage-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Model Context Windows", () => {
    it("returns correct context window sizes for all models", () => {
      expect(getModelContextWindow("gemini-3.8-flash")).toBe(1_048_576);
      expect(getModelContextWindow("gemini-3.7-flash")).toBe(1_048_576);
      expect(getModelContextWindow("gemini-3.6-flash")).toBe(1_048_576);
      expect(getModelContextWindow("gemini-3.1-pro")).toBe(2_097_152);
      expect(getModelContextWindow("claude-sonnet-4-6")).toBe(200_000);
      expect(getModelContextWindow("claude-opus-4-6-thinking")).toBe(200_000);
      expect(getModelContextWindow("gpt-oss-120b")).toBe(128_000);
      expect(getModelContextWindow("unknown-model")).toBe(1_048_576);
    });
  });

  describe("Pricing Calculations", () => {
    it("keeps full precision for model costs", () => {
      expect(
        calculateUsageCostUsd("gemini-3.7-flash", 1_000_000, 1_000_000, 1_000_000)
      ).toBeCloseTo(0.525, 12);

      const turnCost = calculateUsageCostUsd("gemini-3.8-flash", 10_000, 500, 5_000);
      expect(turnCost).toBeCloseTo(0.001325, 12);

      // This used to round to zero before reaching the session accumulator.
      const microCost = calculateUsageCostUsd("gemini-3.7-flash", 400, 0, 0);
      expect(microCost).toBeCloseTo(0.00004, 12);
    });

    it("calculates cost accurately for Claude Sonnet", () => {
      const cost = calculateUsageCostUsd("claude-sonnet-4-6", 100_000, 2_000, 0);
      expect(cost).toBeCloseTo(0.33, 12);
    });

    it("does not charge unknown models as Gemini Flash and maps known model families", () => {
      // Unmapped models must not silently charge Gemini Flash rates
      expect(calculateUsageCostUsd("totally-unknown-model", 100_000, 10_000)).toBe(0);

      // Model family dynamic variants should resolve appropriately
      expect(
        calculateUsageCostUsd("claude-3-7-sonnet-variant", 100_000, 2_000, 0)
      ).toBeCloseTo(0.33, 12);
      expect(
        calculateUsageCostUsd("gemini-3.9-pro-preview", 100_000, 2_000, 0)
      ).toBeCloseTo(0.135, 12);
    });
  });

  describe("Quota and Limits Parsing", () => {
    it("derives correct tones based on usage percentages", () => {
      expect(deriveUsageTone(10)).toBe("ok");
      expect(deriveUsageTone(50)).toBe("ok");
      expect(deriveUsageTone(75)).toBe("warning");
      expect(deriveUsageTone(89)).toBe("warning");
      expect(deriveUsageTone(90)).toBe("danger");
      expect(deriveUsageTone(100)).toBe("danger");
    });

    it("parses 5-hour and weekly limits correctly from agy /usage output", () => {
      const sample = `
Quota:
Gemini Models\tWeekly Limit Remaining\t87%\t2026-09-09T06:10:04Z
Gemini Models\tFive Hour Limit Remaining\t89%\t2026-09-03T06:11:58Z
Claude and GPT models\tWeekly Limit Remaining\t95%\t2026-09-09T06:42:10Z
Claude and GPT models\tFive Hour Limit Remaining\t20%\t2026-09-03T06:21:47Z
`;
      const windows = parseAgyQuotaOutput(sample);
      expect(windows).toHaveLength(4);
      expect(windows[0]).toMatchObject({
        id: "weekly",
        label: "Weekly",
        remainingPct: 87,
        usedPct: 13,
        resetsAt: "2026-09-09T06:10:04Z",
        tone: "ok",
      });
      expect(windows[1]).toMatchObject({
        id: "session",
        label: "Session (5h)",
        remainingPct: 89,
        usedPct: 11,
        resetsAt: "2026-09-03T06:11:58Z",
        tone: "ok",
      });
      expect(windows[3]).toMatchObject({
        id: "claude_session",
        label: "Claude Session (5h)",
        remainingPct: 20,
        usedPct: 80,
        tone: "warning",
      });
    });

    it("parses credits output correctly", () => {
      expect(parseAgyCreditsOutput("Model credits\nRemaining credits  0\nUpgrade  https://...")).toEqual({
        id: "credits",
        label: "Credits",
        remaining: 0,
        unit: "usd",
        tone: "default",
      });
      expect(parseAgyCreditsOutput("Model credits\nRemaining credits  15.50\nUpgrade  https://...")).toEqual({
        id: "credits",
        label: "Credits",
        remaining: 15.5,
        unit: "usd",
        tone: "ok",
      });
    });

    it("reports the provider unavailable when the primary agy usage probe fails", async () => {
      const missingBinary = path.join(tempDir, "missing-agy");
      const result = await fetchAntigravityUsage(missingBinary, true);
      expect(result.status).toBe("unavailable");
      expect(result.windows).toEqual([]);
      expect(result.error).toContain("Unable to fetch Antigravity quota");
    });
  });

  describe("Session Usage Accumulation & Persistence", () => {
    it("accumulates tokens, cost, and updates context window across turns", () => {
      const store = new SessionStore(path.join(tempDir, "sessions"));
      const manager = new SessionManager({ store });
      const session = manager.createSession({ cwd: "/tmp", model: "gemini-3.7-flash" });

      session.recordTurnUsage({
        input_tokens: 15_000,
        output_tokens: 500,
        cache_read_tokens: 2_000,
      });
      expect(session.usage.inputTokens).toBe(15_000);
      expect(session.usage.outputTokens).toBe(500);
      expect(session.usage.cachedInputTokens).toBe(2_000);
      expect(session.usage.totalTokens).toBe(15_500);
      expect(session.usage.contextWindowUsedTokens).toBe(15_500);
      expect(session.usage.totalCostUsd).toBeGreaterThan(0);
      const turn1Cost = session.usage.totalCostUsd;

      session.recordTurnUsage({
        input_tokens: 20_000,
        output_tokens: 1_000,
        cache_read_tokens: 15_000,
      });
      expect(session.usage.inputTokens).toBe(35_000);
      expect(session.usage.outputTokens).toBe(1_500);
      expect(session.usage.totalTokens).toBe(36_500);
      expect(session.usage.contextWindowUsedTokens).toBe(21_000);
      expect(session.usage.totalCostUsd).toBeGreaterThan(turn1Cost);

      const restored = new SessionManager({ store }).createSession({ id: session.id });
      expect(restored.usage.inputTokens).toBe(35_000);
      expect(restored.usage.outputTokens).toBe(1_500);
      expect(restored.usage.totalTokens).toBe(36_500);
      expect(restored.usage.totalCostUsd).toBe(session.usage.totalCostUsd);
    });

    it("does not discard repeated micro-costs while accumulating", () => {
      const store = new SessionStore(path.join(tempDir, "micro-sessions"));
      const session = new SessionManager({ store }).createSession({ model: "gemini-3.7-flash" });
      for (let i = 0; i < 3; i++) {
        session.recordTurnUsage({ input_tokens: 400 });
      }
      expect(session.usage.totalCostUsd).toBeCloseTo(0.00012, 12);
    });

    it("updates context window max tokens when model changes", () => {
      const store = new SessionStore(path.join(tempDir, "model-sessions"));
      const session = new SessionManager({ store }).createSession({ model: "gemini-3.7-flash" });
      expect(session.usage.contextWindowMaxTokens).toBe(1_048_576);
      session.setModel("claude-sonnet-4-6");
      expect(session.usage.contextWindowMaxTokens).toBe(200_000);
      session.setModel("gemini-3.1-pro");
      expect(session.usage.contextWindowMaxTokens).toBe(2_097_152);
    });
  });

  describe("ACP turn accounting", () => {
    it("records token usage even when the Antigravity turn returns ERROR", async () => {
      const store = new SessionStore(path.join(tempDir, "error-sessions"));
      const manager = new SessionManager({ store });
      const session = manager.createSession({ cwd: tempDir, model: "gemini-3.7-flash" });
      vi.spyOn(session.process, "sendPrompt").mockResolvedValue({
        event: "result",
        result: {
          conversation_id: "823fb330-71e5-43b9-9efd-d9b7323e4b94",
          status: "ERROR",
          response: "",
          error: "tool failed after model work",
          usage: { input_tokens: 4_000, output_tokens: 100, cache_read_tokens: 500 },
        },
      });

      const harness = makeRpcHarness(manager);
      harness.send({
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId: session.id, prompt: "do work" },
      });
      const response = await harness.waitForResponse(1);
      expect(response.result.stopReason).toBe("refusal");
      expect(session.usage.inputTokens).toBe(4_000);
      expect(session.usage.outputTokens).toBe(100);
      expect(session.usage.totalCostUsd).toBeGreaterThan(0);
      expect(response.result.usage.totalCostUsd).toBeGreaterThan(0);
      await harness.server.stop();
    });

    it("prices streaming and final usage with the model snapshot that executed the turn", async () => {
      const store = new SessionStore(path.join(tempDir, "snapshot-sessions"));
      const manager = new SessionManager({ store });
      const session = manager.createSession({ cwd: tempDir, model: "gemini-3.7-flash" });

      vi.spyOn(session.process, "sendPrompt").mockImplementation(async (_text, onStepUpdate) => {
        // Simulate a model-selection RPC arriving while the old model's turn is running.
        session.setModel("claude-sonnet-4-6");
        onStepUpdate?.({
          event: "step_update",
          step_update: {
            conversation_id: "823fb330-71e5-43b9-9efd-d9b7323e4b94",
            step_index: 1,
            state: "ACTIVE",
            step_type: "agent_response",
            usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0 },
          },
        });
        return {
          event: "result",
          result: {
            conversation_id: "823fb330-71e5-43b9-9efd-d9b7323e4b94",
            status: "SUCCESS",
            response: "ok",
            usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0 },
          },
        };
      });

      const harness = makeRpcHarness(manager);
      harness.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: session.id, prompt: "price with original model" },
      });
      const response = await harness.waitForResponse(2);
      expect(response.result.stopReason).toBe("end_turn");
      expect(session.model).toBe("claude-sonnet-4-6");
      // Gemini Flash 1M input = $0.10. Claude would incorrectly produce $3.00.
      expect(session.usage.totalCostUsd).toBeCloseTo(0.1, 12);

      const streamingUsage = harness.messages.find(
        (message) => message.params?.update?.sessionUpdate === "usage_update"
      );
      expect(streamingUsage.params.update.totalCostUsd).toBeCloseTo(0.1, 6);
      expect(streamingUsage.params.update.contextWindowMaxTokens).toBe(1_048_576);

      // Final response payload must also reflect the executing model's context limit
      expect(response.result.usage.contextWindowMaxTokens).toBe(1_048_576);
      await harness.server.stop();
    });
  });
});
