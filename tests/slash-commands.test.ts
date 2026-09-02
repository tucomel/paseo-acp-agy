import { describe, it, expect } from "vitest";
import {
  AVAILABLE_SLASH_COMMANDS,
  executeSlashCommand,
  listRecentConversations,
  formatUsageOutput,
  formatStepsTimeline,
  getConversationSteps,
  ConversationStepItem,
} from "../src/slash-commands.js";
import { Session } from "../src/session.js";

describe("Slash Commands Handler", () => {
  const dummySession = new Session({
    id: "test-session-slash",
    cwd: process.cwd(),
    model: "gemini-3.7-flash",
    effort: "high",
    mode: "default",
  });

  it("should list available slash commands for ACP auto-complete", () => {
    const names = AVAILABLE_SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain("resume");
    expect(names).toContain("usage");
    expect(names).toContain("help");
    expect(names).toContain("skills");
    expect(names).toContain("credits");
    expect(names).toContain("agents");
    expect(names).toContain("changelog");
  });

  it("should handle /help and return formatted help documentation", async () => {
    const result = await executeSlashCommand("/help", dummySession, "agy");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("/resume");
    expect(result.response).toContain("/usage");
    expect(result.response).toContain("/help");
  });

  it("should handle /resume without arguments by listing recent conversations with steps", async () => {
    const result = await executeSlashCommand("/resume", dummySession, "agy");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("Sessões Recentes");
    // If conversations exist in brain, should mention steps
    const recent = listRecentConversations(1);
    if (recent.length > 0 && recent[0].totalSteps > 0) {
      expect(result.response).toContain("steps");
    }
  });

  it("should format steps timeline correctly for conversation history", () => {
    const sampleSteps: ConversationStepItem[] = [
      { index: 0, role: "user", text: "Primeiro comando" },
      { index: 1, role: "assistant", text: "Resposta inicial" },
      { index: 2, role: "tool", text: "Ferramenta: view_file(foo.txt)" },
      { index: 3, role: "assistant", text: "Conclusão" },
    ];

    const timeline = formatStepsTimeline(sampleSteps);
    expect(timeline).toContain("Histórico de Passos (Steps)");
    expect(timeline).toContain("Step 0");
    expect(timeline).toContain("Primeiro comando");
    expect(timeline).toContain("Step 2");
    expect(timeline).toContain("Ferramenta");
    expect(timeline).toContain("Step 3");
  });

  it("should truncate middle steps cleanly when there are many steps", () => {
    const manySteps: ConversationStepItem[] = Array.from({ length: 20 }, (_, i) => ({
      index: i,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Passo número ${i}`,
    }));

    const timeline = formatStepsTimeline(manySteps);
    expect(timeline).toContain("Step 0");
    expect(timeline).toContain("Step 1");
    expect(timeline).toContain("passos intermediários ocultos");
    expect(timeline).toContain("Step 19");
  });

  it("should handle /resume with non-existent ID gracefully", async () => {
    const result = await executeSlashCommand(
      "/resume non-existent-id-00000",
      dummySession,
      "agy"
    );
    expect(result.handled).toBe(true);
    expect(result.response).toContain("Sessão não encontrada");
  });

  it("should handle /usage", async () => {
    const result = await executeSlashCommand("/usage", dummySession, "agy");
    expect(result.handled).toBe(true);
    expect(result.response).toBeDefined();
  });

  it("should format /usage output into a beautiful markdown card layout with progress bars", () => {
    const rawSample =
      "Gemini Models\tWeekly Limit Remaining\t91%\t2026-09-09T06:10:04Z\nGemini Models\tFive Hour Limit Remaining\t78%\t2026-09-02T18:19:50Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-09T06:42:10Z";
    const formatted = formatUsageOutput(rawSample);
    expect(formatted).toContain("Quotas de Uso");
    expect(formatted).toContain("Google Gemini");
    expect(formatted).toContain("Claude & GPT");
    expect(formatted).toContain("█"); // Progress bar character
    expect(formatted).toContain("🟢"); // Status badge
    expect(formatted).toContain("Semanal");
    expect(formatted).toContain("5 Horas");
  });

  it("should pass through unknown or model-level slash commands like /plan", async () => {
    const result = await executeSlashCommand("/plan do something", dummySession, "agy");
    expect(result.handled).toBe(false);
  });
});
