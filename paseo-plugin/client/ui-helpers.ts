import type { UsageTone } from "../shared/telemetry.ts";
export { fmtCost, fmtResetRelative, fmtTokens, toneColor, buildPillLabel } from "./format.ts";

export function deriveToneFromPct(pct: number): UsageTone {
  if (pct >= 90) return "danger";
  if (pct >= 75) return "warning";
  return "ok";
}
