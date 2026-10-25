import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export function isAntigravityProvider(provider: unknown): boolean {
  if (typeof provider !== "string") return false;
  const normalized = provider.trim().toLowerCase();
  return normalized === "antigravity" || normalized.startsWith("antigravity/");
}

export const UsageToneSchema = z.enum(["default", "ok", "warning", "danger"]);
export type UsageTone = z.infer<typeof UsageToneSchema>;

export const QuotaWindowItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  shortLabel: z.string().optional(),
  summary: z.boolean().optional(),
  usedPct: z.number(),
  remainingPct: z.number(),
  resetsAt: z.string().nullable(),
  tone: UsageToneSchema,
});
export type QuotaWindowItem = z.infer<typeof QuotaWindowItemSchema>;

export const CreditsBalanceItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  remaining: z.number(),
  unit: z.literal("usd"),
  tone: UsageToneSchema,
});
export type CreditsBalanceItem = z.infer<typeof CreditsBalanceItemSchema>;

export const QuotaReportSchema = z.object({
  status: z.enum(["available", "unavailable", "error"]),
  planLabel: z.string().nullable(),
  windows: z.array(QuotaWindowItemSchema),
  balances: z.array(CreditsBalanceItemSchema),
  error: z.string().nullable(),
  fetchedAt: z.string(),
});
export type QuotaReport = z.infer<typeof QuotaReportSchema>;

export const SessionTelemetrySchema = z.object({
  agentId: z.string(),
  sessionId: z.string().nullable(),
  conversationId: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  activeTurn: z.boolean(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  totalTokens: z.number(),
  totalCostUsd: z.number(),
  contextWindowUsedTokens: z.number(),
  contextWindowMaxTokens: z.number(),
  contextPct: z.number(),
  updatedAt: z.string().nullable(),
  source: z.enum(["acp_store", "agent_snapshot", "default"]),
});
export type SessionTelemetry = z.infer<typeof SessionTelemetrySchema>;

export const TelemetryResponseSchema = z.object({
  session: SessionTelemetrySchema,
  quota: QuotaReportSchema,
});
export type TelemetryResponse = z.infer<typeof TelemetryResponseSchema>;

export const agyTelemetryGet = defineRpc({
  name: "agy-telemetry.get",
  input: z.object({
    agentId: z.string(),
    forceQuota: z.boolean().optional(),
  }),
  output: TelemetryResponseSchema,
});
