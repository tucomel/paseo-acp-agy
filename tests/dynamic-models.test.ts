import { describe, it, expect } from "vitest";
import {
  parseAgyModelsOutput,
  FALLBACK_MODELS,
  getEffectiveEffortForModel,
  buildConfigOptionsForModel,
} from "../src/protocol.js";

describe("Dynamic Model & Effort Discovery", () => {
  const sampleAgyOutput = `Fetching available models...
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.7-flash-low\tGemini 3.7 Flash (Low)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

  it("should parse tab-separated agy models output and extract per-model supported efforts", () => {
    const models = parseAgyModelsOutput(sampleAgyOutput);

    expect(models.length).toBe(6);

    const g37 = models.find((m) => m.modelId === "gemini-3.7-flash");
    expect(g37).toBeDefined();
    expect(g37?.supportedEfforts).toEqual(["high", "medium", "low"]);

    const g31 = models.find((m) => m.modelId === "gemini-3.1-pro");
    expect(g31).toBeDefined();
    expect(g31?.supportedEfforts).toEqual(["high", "low"]); // No medium!

    const claude = models.find((m) => m.modelId === "claude-sonnet-4-6");
    expect(claude).toBeDefined();
    expect(claude?.supportedEfforts).toEqual([]); // No effort options

    const gpt = models.find((m) => m.modelId === "gpt-oss-120b");
    expect(gpt).toBeDefined();
    expect(gpt?.supportedEfforts).toEqual(["medium"]);
  });

  it("should resolve effective effort per model correctly", () => {
    const models = parseAgyModelsOutput(sampleAgyOutput);

    // Claude does not support effort -> undefined
    expect(getEffectiveEffortForModel("claude-sonnet-4-6", "high", models)).toBeUndefined();
    expect(getEffectiveEffortForModel("claude-opus-4-6-thinking", "low", models)).toBeUndefined();

    // Gemini 3.1 Pro only supports high and low. If medium requested, fallback to high
    expect(getEffectiveEffortForModel("gemini-3.1-pro", "medium", models)).toBe("high");
    expect(getEffectiveEffortForModel("gemini-3.1-pro", "low", models)).toBe("low");
    expect(getEffectiveEffortForModel("gemini-3.1-pro", "high", models)).toBe("high");

    // Gemini 3.7 supports high, medium, low
    expect(getEffectiveEffortForModel("gemini-3.7-flash", "medium", models)).toBe("medium");
    expect(getEffectiveEffortForModel("gemini-3.7-flash", "low", models)).toBe("low");
  });

  it("should build reactive configOptions tailored to the active model", () => {
    const models = parseAgyModelsOutput(sampleAgyOutput);

    // Claude -> empty configOptions (no thinking selector)
    const claudeOptions = buildConfigOptionsForModel("claude-sonnet-4-6", "high", models);
    expect(claudeOptions).toEqual([]);

    // Gemini 3.1 Pro -> select option with only Low and High (no Medium)
    const g31Options = buildConfigOptionsForModel("gemini-3.1-pro", "high", models);
    expect(g31Options.length).toBe(1);
    expect(g31Options[0].options.map((o) => o.value)).toEqual(["high", "low"]);

    // Gemini 3.7 Flash -> select option with High, Medium, Low
    const g37Options = buildConfigOptionsForModel("gemini-3.7-flash", "medium", models);
    expect(g37Options.length).toBe(1);
    expect(g37Options[0].options.map((o) => o.value)).toEqual(["high", "medium", "low"]);
    expect(g37Options[0].currentValue).toBe("medium");
  });
});
