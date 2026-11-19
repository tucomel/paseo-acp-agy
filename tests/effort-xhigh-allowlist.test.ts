import { describe, it, expect, afterEach } from "vitest";
import { parseAgyModelsOutput } from "../src/protocol.js";

const SAMPLE = [
  "Fetching available models...",
  "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
  "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
  "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
  "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)",
].join("\n");

describe("agy models parsing: xhigh effort and allowlist", () => {
  afterEach(() => { delete process.env.AGY_ACP_ALLOWED_MODELS; });

  it("folds -xhigh into the base model as an effort level", () => {
    const models = parseAgyModelsOutput(SAMPLE);
    const hydrogen = models.find((m) => m.modelId === "gemini-4-hydrogen");
    expect(hydrogen?.supportedEfforts).toEqual(["high", "xhigh", "medium", "low"]);
    expect(hydrogen?.name).toBe("Gemini 4 Hydrogen");
    expect(models.find((m) => m.modelId === "gemini-4-hydrogen-xhigh")).toBeUndefined();
  });

  it("limits exposed models with AGY_ACP_ALLOWED_MODELS", () => {
    process.env.AGY_ACP_ALLOWED_MODELS = "gemini-4-hydrogen, gemini-3.8-flash";
    const ids = parseAgyModelsOutput(SAMPLE).map((m) => m.modelId);
    expect(ids).toEqual(["gemini-4-hydrogen", "gemini-3.8-flash"]);
  });
});

describe("allowlist helper", () => {
  afterEach(() => { delete process.env.AGY_ACP_ALLOWED_MODELS; });
  it("keeps everything when unset and filters fallback models when set", async () => {
    const { applyModelAllowlist, FALLBACK_MODELS } = await import("../src/protocol.js");
    expect(applyModelAllowlist(FALLBACK_MODELS)).toHaveLength(FALLBACK_MODELS.length);
    process.env.AGY_ACP_ALLOWED_MODELS = "gemini-3.8-flash";
    expect(applyModelAllowlist(FALLBACK_MODELS).map((m) => m.modelId)).toEqual(["gemini-3.8-flash"]);
  });
});
