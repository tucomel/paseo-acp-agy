import type { PluginServerContext } from "@getpaseo/plugin/server";
import { agyTelemetryGet } from "./shared/telemetry.ts";
import {
  createAntigravityUsageSource,
  fetchAntigravityQuota,
  resolveSessionTelemetry,
  type AgentSnapshotInfo,
} from "./server/agy-usage.ts";

export default function contribute(server: PluginServerContext) {
  const maybeRegisterUsage = (
    server as unknown as {
      registerUsageSource?: (source: ReturnType<typeof createAntigravityUsageSource>) => (() => void) | void;
    }
  ).registerUsageSource;

  let disposeUsageSource: (() => void) | void;
  if (typeof maybeRegisterUsage === "function") {
    try {
      disposeUsageSource = maybeRegisterUsage.call(server, createAntigravityUsageSource());
    } catch (err) {
      console.warn("[antigravity-telemetry] Could not register usage source:", err);
    }
  }

  server.handle(agyTelemetryGet, async (input, context) => {
    let snapshot: AgentSnapshotInfo | null = null;
    try {
      const handle = context.paseo.agents.ref(input.agentId);
      await handle.refresh();
      snapshot = (handle.current() as unknown as AgentSnapshotInfo | null) ?? null;
    } catch {}

    const [session, quota] = await Promise.all([
      Promise.resolve(resolveSessionTelemetry(input.agentId, snapshot)),
      fetchAntigravityQuota(Boolean(input.forceQuota)),
    ]);

    return { session, quota };
  });

  return async () => {
    if (typeof disposeUsageSource === "function") {
      disposeUsageSource();
    }
  };
}
