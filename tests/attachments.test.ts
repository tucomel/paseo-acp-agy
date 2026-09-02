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
});
