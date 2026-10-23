import { describe, it, expect } from "vitest";
import { normalizeToolCall, normalizeToolResult, extractPlanEntries } from "../src/tool-formatter.js";

describe("Tool Formatter & Visual Enhancements", () => {
  it("normalizes run_command with descriptive title, execute kind, and command parameter", () => {
    const res = normalizeToolCall(
      "run_command",
      { CommandLine: "git status --short", toolSummary: "Git status check" },
      1
    );

    expect(res.toolCallId).toBe("tool_1");
    expect(res.title).toBe("Git status check");
    expect(res.kind).toBe("execute");
    expect(res.rawInput.command).toBe("git status --short");
    expect(res.rawInput.CommandLine).toBe("git status --short");
  });

  it("normalizes read_file with path, locations, and read kind", () => {
    const res = normalizeToolCall(
      "read_file",
      { Path: "/home/ubuntu/projects/app/package.json", StartLine: 10 },
      2
    );

    expect(res.toolCallId).toBe("tool_2");
    expect(res.title).toBe("package.json:10");
    expect(res.kind).toBe("read");
    expect(res.locations).toEqual([{ path: "/home/ubuntu/projects/app/package.json", line: 10 }]);
    expect(res.rawInput.path).toBe("/home/ubuntu/projects/app/package.json");
    expect(res.rawInput.filePath).toBe("/home/ubuntu/projects/app/package.json");
  });

  it("normalizes edit_file with target, replacement, locations, and diff block", () => {
    const res = normalizeToolCall(
      "edit_file",
      {
        Path: "/src/index.ts",
        Target: "const x = 1;",
        Replacement: "const x = 2;",
      },
      3
    );

    expect(res.toolCallId).toBe("tool_3");
    expect(res.title).toBe("index.ts");
    expect(res.kind).toBe("edit");
    expect(res.locations).toEqual([{ path: "/src/index.ts" }]);
    expect(res.rawInput.oldText).toBe("const x = 1;");
    expect(res.rawInput.newText).toBe("const x = 2;");

    const result = normalizeToolResult(
      "edit_file",
      {
        Path: "/src/index.ts",
        Target: "const x = 1;",
        Replacement: "const x = 2;",
      },
      "File edited successfully."
    );

    expect(result.status).toBe("completed");
    expect(result.content).toBeDefined();
    expect(result.content?.[0]).toEqual({
      type: "diff",
      path: "/src/index.ts",
      oldText: "const x = 1;",
      newText: "const x = 2;",
    });
  });

  it("normalizes search_web and grep_search with search kind", () => {
    const res = normalizeToolCall("search_web", { query: "Paseo Agent Client Protocol" }, 4);
    expect(res.kind).toBe("search");
    expect(res.title).toBe("Busca: Paseo Agent Client Protocol");
    expect(res.rawInput.query).toBe("Paseo Agent Client Protocol");
  });

  it("normalizes invoke_subagent with subagent badge and role", () => {
    const res = normalizeToolCall(
      "invoke_subagent",
      { Role: "Database Architect", Prompt: "Review migrations" },
      5
    );
    expect(res.title).toBe("🤖 Subagente: Database Architect");
    expect(res.kind).toBe("execute");
    expect(res.rawInput.role).toBe("Database Architect");
  });

  it("formats ask_question into an interactive markdown question card", () => {
    const res = normalizeToolCall(
      "ask_question",
      {
        questions: [
          {
            question: "Qual banco de dados deseja configurar?",
            options: ["(Recommended) PostgreSQL", "SQLite", "MySQL"],
          },
        ],
      },
      6
    );

    expect(res.kind).toBe("other");
    expect(res.title).toBe("❓ Pergunta do Assistente");
    expect(res.questionCard).toBeDefined();
    expect(res.questionCard).toContain("Qual banco de dados deseja configurar?");
    expect(res.questionCard).toContain("**[1]** PostgreSQL *(Recomendado)*");
    expect(res.questionCard).toContain("**[2]** SQLite");
    expect(res.questionCard).toContain("**[3]** MySQL");
    expect(res.questionCard).toContain("Escolha única");
  });

  it("formats multiple questions with multi-select support correctly", () => {
    const res = normalizeToolCall(
      "ask_question",
      {
        questions: [
          {
            question: "Qual framework frontend prefere?",
            is_multi_select: false,
            options: ["(Recommended) Next.js", "Remix", "Vite"],
          },
          {
            question: "Quais provedores de autenticação devemos incluir?",
            is_multi_select: true,
            options: ["(Recommended) Google OAuth", "GitHub OAuth", "Email / Senha"],
          },
        ],
      },
      7
    );

    expect(res.questionCard).toContain("Pergunta 1 de 2");
    expect(res.questionCard).toContain("Escolha única");
    expect(res.questionCard).toContain("Pergunta 2 de 2");
    expect(res.questionCard).toContain("Múltipla escolha (você pode selecionar mais de uma opção");
    expect(res.questionCard).toContain("- [ ] **[1]** Google OAuth *(Recomendado)*");
    expect(res.questionCard).toContain("- [ ] **[2]** GitHub OAuth");
    expect(res.questionCard).toContain("- [ ] **[3]** Email / Senha");
  });

  it("extracts markdown checklist items into Paseo plan entries", () => {
    const text = `
Here is my plan:
- [x] Analyze codebase structure
- [/] Refactor protocol definitions
- [ ] Implement new tool visualizer
- [ ] Run full test suite
`;
    const plan = extractPlanEntries(text);
    expect(plan).toBeDefined();
    expect(plan).toHaveLength(4);
    expect(plan?.[0]).toEqual({ content: "Analyze codebase structure", status: "completed" });
    expect(plan?.[1]).toEqual({ content: "Refactor protocol definitions", status: "in_progress" });
    expect(plan?.[2]).toEqual({ content: "Implement new tool visualizer", status: "pending" });
    expect(plan?.[3]).toEqual({ content: "Run full test suite", status: "pending" });
  });

  it("returns null for text without checklist items", () => {
    expect(extractPlanEntries("Just normal assistant reply.")).toBeNull();
  });
});
