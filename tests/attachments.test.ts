import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { saveBase64Image } from "../src/attachments.js";
import { extractPromptText } from "../src/protocol.js";

describe("Prompt Attachments & Image Support", () => {
  const sampleBase64Png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("should save base64 image with 0o600 permissions", () => {
    const savedPath = saveBase64Image(sampleBase64Png, "image/png");
    expect(fs.existsSync(savedPath)).toBe(true);
    const stat = fs.statSync(savedPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("should extract prompt and handle image-only input without empty prompt error", () => {
    const promptInput = [
      {
        type: "image",
        data: sampleBase64Png,
        mimeType: "image/png",
      },
    ];

    const result = extractPromptText(promptInput);
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe("");
    expect(result).toContain("[Attached Image:");
    expect(result).toContain("view_file");
  });

  it("should combine text and attached images correctly", () => {
    const promptInput = [
      {
        type: "text",
        text: "Analyze this diagram and explain it",
      },
      {
        type: "image",
        data: sampleBase64Png,
        mimeType: "image/png",
      },
    ];

    const result = extractPromptText(promptInput);
    expect(result).toContain("Analyze this diagram and explain it");
    expect(result).toContain("[Attached Image:");
    expect(result).toContain("view_file");
  });

  it("should fallback gracefully when prompt is empty", () => {
    expect(extractPromptText("")).toBe("Please continue.");
    expect(extractPromptText([])).toBe("Please continue.");
  });

  it("should format review attachments with hunk headers, line numbers, and target markers", () => {
    const reviewBlock = {
      type: "review",
      mode: "base",
      baseRef: "origin/main",
      cwd: "/repo",
      comments: [
        {
          filePath: "src/main.ts",
          side: "RIGHT",
          lineNumber: 42,
          body: "Consider caching this computation.",
          context: {
            hunkHeader: "@@ -40,5 +40,6 @@",
            targetLine: {
              oldLineNumber: null,
              newLineNumber: 42,
              type: "add",
              content: "const expensive = compute();",
            },
            lines: [
              {
                oldLineNumber: 40,
                newLineNumber: 40,
                type: "context",
                content: "function run() {",
              },
              {
                oldLineNumber: 41,
                newLineNumber: 41,
                type: "context",
                content: "  const a = 1;",
              },
              {
                oldLineNumber: null,
                newLineNumber: 42,
                type: "add",
                content: "const expensive = compute();",
              },
            ],
          },
        },
      ],
    };

    const result = extractPromptText([reviewBlock]);
    expect(result).toContain("Code review (diff against origin/main in /repo):");
    expect(result).toContain("Comment 1: src/main.ts:RIGHT:42");
    expect(result).toContain("Consider caching this computation.");
    expect(result).toContain("@@ -40,5 +40,6 @@");
    expect(result).toContain("  40 40  function run() {");
    expect(result).toContain(">  - 42 +const expensive = compute();");
  });

  it("should format issue attachments correctly", () => {
    const issueBlock = {
      type: "github_issue",
      number: 123,
      title: "Fix memory leak in websocket listener",
      url: "https://github.com/org/repo/issues/123",
      body: "Details about the memory leak.",
    };

    const result = extractPromptText([issueBlock]);
    expect(result).toContain("Issue #123: Fix memory leak in websocket listener");
    expect(result).toContain("URL: https://github.com/org/repo/issues/123");
    expect(result).toContain("Details about the memory leak.");
  });

  it("should format pull request attachments correctly", () => {
    const prBlock = {
      type: "github_pr",
      number: 456,
      title: "Add Antigravity ACP integration",
      url: "https://github.com/org/repo/pull/456",
      headRefName: "feat/agy",
      baseRefName: "main",
      body: "Ports all features and fixes Oracle usage.",
    };

    const result = extractPromptText([prBlock]);
    expect(result).toContain("Pull Request #456: Add Antigravity ACP integration (feat/agy -> main)");
    expect(result).toContain("URL: https://github.com/org/repo/pull/456");
    expect(result).toContain("Ports all features and fixes Oracle usage.");
  });

  it("should format uploaded file and external resource text blocks", () => {
    const blocks = [
      {
        type: "uploaded_file",
        fileName: "schema.sql",
        mimeType: "text/x-sql",
        path: "/tmp/schema.sql",
      },
      {
        type: "text",
        text: "SELECT * FROM users;",
        title: "Database Query",
        externalResource: {
          url: "https://db.internal/query/1",
        },
      },
    ];

    const result = extractPromptText(blocks);
    expect(result).toContain("[Attached File: schema.sql (text/x-sql)]");
    expect(result).toContain("Path: /tmp/schema.sql");
    expect(result).toContain("[Database Query (https://db.internal/query/1)]");
    expect(result).toContain("SELECT * FROM users;");
  });
});
