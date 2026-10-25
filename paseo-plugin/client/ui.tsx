import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { QuotaWindowItem, TelemetryResponse } from "../shared/telemetry.ts";
import { useAntigravityTelemetry } from "./data.ts";
import { deriveToneFromPct, fmtCost, fmtResetRelative, fmtTokens, toneColor } from "./ui-helpers.ts";

function MetricBox({
  label,
  value,
  subvalue,
  theme,
}: {
  label: string;
  value: string;
  subvalue?: string;
  theme: PluginTheme;
}) {
  return (
    <View
      style={{
        flex: 1,
        minWidth: 105,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        gap: 2,
      }}
    >
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 10,
          fontWeight: "600",
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      {subvalue ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            fontVariant: ["tabular-nums"],
          }}
        >
          {subvalue}
        </Text>
      ) : null}
    </View>
  );
}

function ProgressRow({
  label,
  rightText,
  subText,
  pct,
  color,
  theme,
}: {
  label: string;
  rightText: string;
  subText?: string;
  pct: number;
  color: string;
  theme: PluginTheme;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={{ gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "500", flex: 1 }}>
          {label}
        </Text>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 12,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {rightText}
        </Text>
      </View>
      <View
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: theme.colors.border,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${Math.round(clamped)}%`,
            height: 6,
            borderRadius: 3,
            backgroundColor: color,
          }}
        />
      </View>
      {subText ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            fontVariant: ["tabular-nums"],
          }}
        >
          {subText}
        </Text>
      ) : null}
    </View>
  );
}

function QuotaWindowRow({ win, theme }: { win: QuotaWindowItem; theme: PluginTheme }) {
  const resetText = fmtResetRelative(win.resetsAt);
  const subParts = [`${Math.round(win.remainingPct)}% remaining`];
  if (resetText) subParts.push(resetText);
  return (
    <ProgressRow
      label={win.label}
      rightText={`${Math.round(win.usedPct)}% used`}
      subText={subParts.join(" · ")}
      pct={win.usedPct}
      color={toneColor(win.tone, theme)}
      theme={theme}
    />
  );
}

export function TelemetryBody({
  data,
  refreshing,
  onRefresh,
  onOpenPanel,
  compact,
  theme,
}: {
  data: TelemetryResponse;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenPanel?: () => void;
  compact: boolean;
  theme: PluginTheme;
}) {
  const { session, quota } = data;
  const ctxTone = deriveToneFromPct(session.contextPct);
  const credits = quota.balances.find((b) => b.id === "credits") ?? null;

  return (
    <View style={{ gap: compact ? 12 : 14 }}>
      <View
        style={{
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          gap: 8,
        }}
      >
        <ProgressRow
          label={`Context Window${session.model ? ` · ${session.model}` : ""}`}
          rightText={`${session.contextPct.toFixed(1)}%`}
          subText={`${fmtTokens(session.contextWindowUsedTokens)} / ${fmtTokens(session.contextWindowMaxTokens)} tokens${session.activeTurn ? " · live turn" : ""}`}
          pct={session.contextPct}
          color={toneColor(ctxTone, theme)}
          theme={theme}
        />
      </View>

      <View style={{ gap: 6 }}>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            fontWeight: "600",
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Session Tokens & Cost
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <MetricBox
            label="Session Cost"
            value={fmtCost(session.totalCostUsd)}
            subvalue={`${fmtTokens(session.totalTokens)} total`}
            theme={theme}
          />
          <MetricBox
            label="Input / Cache"
            value={fmtTokens(session.inputTokens)}
            subvalue={`${fmtTokens(session.cachedInputTokens)} cached`}
            theme={theme}
          />
          <MetricBox
            label="Output"
            value={fmtTokens(session.outputTokens)}
            subvalue={session.effort ? `effort: ${session.effort}` : undefined}
            theme={theme}
          />
        </View>
      </View>

      <View
        style={{
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11,
              fontWeight: "600",
              letterSpacing: 0.5,
              textTransform: "uppercase",
              flex: 1,
            }}
          >
            Antigravity Quota Windows
          </Text>
          <Pressable
            onPress={onRefresh}
            disabled={refreshing}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: theme.colors.surface0,
              borderWidth: 1,
              borderColor: theme.colors.border,
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <Icon name="RefreshCw" size={12} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "500" }}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </Text>
          </Pressable>
        </View>

        {quota.windows.length > 0 ? (
          <View style={{ gap: 10 }}>
            {quota.windows.map((win) => (
              <QuotaWindowRow key={win.id} win={win} theme={theme} />
            ))}
          </View>
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {quota.error ?? "No quota windows available."}
          </Text>
        )}

        {credits ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: 6,
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
            }}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Model Credits</Text>
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 12,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
              }}
            >
              ${credits.remaining.toFixed(2)} USD
            </Text>
          </View>
        ) : null}
      </View>

      {onOpenPanel ? (
        <Pressable
          onPress={onOpenPanel}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Icon name="PanelRight" size={13} color={theme.colors.foreground} />
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            Open Telemetry Panel
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function AntigravityTelemetryPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const { data, error, refreshing, refreshQuota } = useAntigravityTelemetry(agentId);
  const title = useAgent(agentId, (agent) => agent.title ?? agentId.slice(0, 8));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 18, gap: 14 }}
    >
      <View style={{ gap: 2 }}>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            fontWeight: "600",
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Antigravity Session Telemetry
        </Text>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
          {title}
        </Text>
      </View>

      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{String(error)}</Text>
      ) : null}

      {data ? (
        <TelemetryBody
          data={data}
          refreshing={refreshing}
          onRefresh={() => void refreshQuota()}
          compact={layout.compact}
          theme={theme}
        />
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Loading telemetry…</Text>
      )}
    </ScrollView>
  );
}
