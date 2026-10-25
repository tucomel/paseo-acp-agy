import { usePaseo, useRpc, type PluginClientContext } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { agyTelemetryGet, isAntigravityProvider } from "../shared/telemetry.ts";

type PaseoApi = PluginClientContext["paseo"];

const QUERY_NAMESPACE = "antigravity-telemetry";

const coordinators = new WeakMap<
  QueryClient,
  Map<PaseoApi, { count: number; dispose: () => void }>
>();

function useAgentTelemetryInvalidation(): void {
  const paseo = usePaseo();
  const cache = useQueryClient();

  useEffect(() => {
    let byClient = coordinators.get(cache);
    if (!byClient) {
      byClient = new Map();
      coordinators.set(cache, byClient);
    }

    let entry = byClient.get(paseo);
    if (!entry) {
      const fingerprints = new Map<string, string>();
      const dirty = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const unsubscribe = paseo.agents.subscribe((event) => {
        if (event.kind === "upsert" && !isAntigravityProvider(event.agent.provider)) {
          return;
        }
        const id = event.kind === "upsert" ? event.agent.id : event.agentId;
        const fp =
          event.kind === "upsert"
            ? JSON.stringify([
                event.agent.activeTurn,
                event.agent.lastUsage,
                event.agent.status,
                event.agent.model,
                event.agent.updatedAt,
              ])
            : "removed";
        if (fingerprints.get(id) === fp) return;
        fingerprints.set(id, fp);
        dirty.add(id);

        timer ??= setTimeout(() => {
          timer = undefined;
          for (const agentId of dirty) {
            void cache.invalidateQueries({ queryKey: [QUERY_NAMESPACE, "agent", agentId] });
          }
          dirty.clear();
        }, 350);
      });

      entry = {
        count: 0,
        dispose: () => {
          unsubscribe();
          clearTimeout(timer);
        },
      };
      byClient.set(paseo, entry);
    }

    entry.count++;
    return () => {
      if (--entry.count === 0) {
        entry.dispose();
        byClient.delete(paseo);
      }
    };
  }, [paseo, cache]);
}

export function useAntigravityTelemetry(agentId: string) {
  const fetchRpc = useRpc(agyTelemetryGet);
  const cache = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  useAgentTelemetryInvalidation();

  const queryKey = [QUERY_NAMESPACE, "agent", agentId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => fetchRpc({ agentId }),
    staleTime: 1_500,
    refetchInterval: (q) => (q.state.data?.session.activeTurn ? 4_000 : 30_000),
  });

  const refreshQuota = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await fetchRpc({ agentId, forceQuota: true });
      cache.setQueryData(queryKey, fresh);
    } finally {
      setRefreshing(false);
    }
  }, [agentId, cache, fetchRpc]);

  return {
    ...query,
    refreshing,
    refreshQuota,
  };
}
