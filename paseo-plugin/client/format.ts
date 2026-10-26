import type { PluginTheme } from "@getpaseo/plugin";
import type { QuotaReport, SessionTelemetry, UsageTone } from "../shared/telemetry.ts";

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtResetRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "resets soon";
  const totalMins = Math.round(diffMs / 60_000);
  if (totalMins < 60) return `resets in ${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours < 24) return mins > 0 ? `resets in ${hours}h ${mins}m` : `resets in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `resets in ${days}d ${remHours}h` : `resets in ${days}d`;
}

export function toneColor(tone: UsageTone, theme: PluginTheme): string {
  if (tone === "danger") return theme.colors.statusDanger;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "ok") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

export function buildPillLabel(session: SessionTelemetry, quota: QuotaReport): string {
  const parts: string[] = [];

  parts.push(`${Math.round(session.contextPct)}% ctx`);

  if (session.totalCostUsd > 0) {
    parts.push(fmtCost(session.totalCostUsd));
  } else if (session.totalTokens > 0) {
    parts.push(`${fmtTokens(session.totalTokens)} tok`);
  } else {
    parts.push("$0.00");
  }

  const primaryFiveHour =
    quota.windows.find((w) => w.id === "session") ?? quota.windows[0] ?? null;
  if (primaryFiveHour) {
    parts.push(`5h ${Math.round(primaryFiveHour.usedPct)}%`);
  }

  return parts.join(" · ");
}
