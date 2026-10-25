import type { PluginTheme } from "@getpaseo/plugin";
import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { isAntigravityProvider } from "../shared/telemetry.ts";
import { useAntigravityTelemetry } from "./data.ts";
import { TelemetryBody } from "./ui.tsx";
import { buildPillLabel } from "./ui-helpers.ts";

interface PopoverProps {
  theme: PluginTheme;
  layout: { compact: boolean };
  close: () => void;
}

export function contributeAntigravityPills(client: PluginClientContext): () => Promise<void> {
  const pills = new Map<string, { workspaceId: string; handle: PluginButtonRegistration }>();
  const lifetime = new AbortController();

  const remove = (agentId: string) => {
    pills.get(agentId)?.handle.remove();
    pills.delete(agentId);
  };

  const removeAll = () => {
    for (const entry of pills.values()) entry.handle.remove();
    pills.clear();
  };

  const upsert = (agent: {
    id: string;
    provider?: string | null;
    workspaceId?: string | null;
    status?: string | null;
    archivedAt?: string | null;
  }) => {
    if (lifetime.signal.aborted) return;
    const workspaceId = agent.workspaceId;
    if (
      !isAntigravityProvider(agent.provider) ||
      !workspaceId ||
      agent.status === "closed" ||
      agent.archivedAt
    ) {
      remove(agent.id);
      return;
    }

    if (pills.get(agent.id)?.workspaceId === workspaceId) {
      return;
    }

    remove(agent.id);

    const agentId = agent.id;
    let handle: PluginButtonRegistration;

    function TelemetryPillIcon(props: PluginButtonIconProps) {
      const { data, error } = useAntigravityTelemetry(agentId);
      useEffect(() => {
        if (!handle) return;
        const nextLabel = error
          ? "AGY"
          : data
            ? buildPillLabel(data.session, data.quota)
            : "AGY …";
        handle.update({ label: nextLabel });
      }, [data, error]);

      return (
        <Icon
          name={data?.session.activeTurn ? "Activity" : "Gauge"}
          size={props.size}
          color={props.color}
        />
      );
    }

    function TelemetryPopover({ theme, layout, close }: PopoverProps) {
      const { data, error, refreshing, refreshQuota } = useAntigravityTelemetry(agentId);
      return (
        <ScrollView
          style={{
            maxHeight: layout.compact ? 480 : 440,
            minWidth: layout.compact ? undefined : 320,
            backgroundColor: theme.colors.surface0,
          }}
          contentContainerStyle={{ padding: 12, gap: 10 }}
        >
          {error ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{String(error)}</Text>
          ) : null}
          {data ? (
            <TelemetryBody
              data={data}
              refreshing={refreshing}
              onRefresh={() => void refreshQuota()}
              onOpenPanel={() => {
                close();
                client.openPanel("telemetry", {
                  workspaceId,
                  agentId,
                  ...(layout.compact ? {} : { location: "explorer" as const }),
                });
              }}
              compact={layout.compact}
              theme={theme}
            />
          ) : (
            <View style={{ padding: 12 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                Loading Antigravity telemetry…
              </Text>
            </View>
          )}
        </ScrollView>
      );
    }

    handle = client.addComposerPill({
      id: `agy-telemetry-${agentId}`,
      workspaceId,
      agentId,
      button: {
        title: "Antigravity Usage & Context Telemetry",
        icon: TelemetryPillIcon,
        label: "AGY …",
        behavior: {
          kind: "popover",
          Content: TelemetryPopover,
        },
      },
    });

    pills.set(agentId, { workspaceId, handle });
  };

  let activeSubscription: { release?: () => Promise<void> | void } | null = null;

  const hydrateRemainingPages = async (initialCursor?: string | null) => {
    let cursor = initialCursor ?? undefined;
    const seen = new Set<string>();
    while (cursor && !lifetime.signal.aborted) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const nextPage: any = await client.paseo.agents.list({
        page: { limit: 200, cursor },
      } as any);
      if (lifetime.signal.aborted) return;
      for (const item of nextPage?.entries ?? []) {
        if (item?.agent) upsert(item.agent);
      }
      cursor = nextPage?.pageInfo?.nextCursor ?? undefined;
    }
  };

  void client.paseo.agents
    .list({ subscribe: {}, page: { limit: 200 } } as any)
    .then(({ entries, pageInfo, subscription }: any) => {
      if (lifetime.signal.aborted) {
        void subscription?.release?.();
        return;
      }
      activeSubscription = subscription ?? null;
      if (Array.isArray(entries)) {
        for (const item of entries) {
          if (item?.agent) upsert(item.agent);
        }
      }
      void hydrateRemainingPages(pageInfo?.nextCursor);
      subscription?.subscribe?.({
        snapshot: (page: any) => {
          removeAll();
          for (const item of page?.entries ?? []) {
            if (item?.agent) upsert(item.agent);
          }
          void hydrateRemainingPages(page?.pageInfo?.nextCursor);
        },
        update: (message: any) => {
          if (message?.type !== "agent_update") return;
          const update = message.payload;
          if (update?.kind === "upsert") upsert(update.agent);
          else if (update?.agentId) remove(update.agentId);
        },
        error: (err: unknown) => {
          if (!lifetime.signal.aborted) {
            console.warn("[antigravity-telemetry] Agent subscription error:", err);
          }
        },
      });
    })
    .catch((err: unknown) => {
      if (!lifetime.signal.aborted) {
        console.warn("[antigravity-telemetry] Failed to subscribe to agents:", err);
      }
    });

  return async () => {
    lifetime.abort();
    removeAll();
    await activeSubscription?.release?.();
  };
}
