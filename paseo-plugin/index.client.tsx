import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeAntigravityPills } from "./client/pill.tsx";
import { AntigravityTelemetryPanel } from "./client/ui.tsx";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "telemetry",
    title: "Antigravity Telemetry",
    icon: "Gauge",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: AntigravityTelemetryPanel,
  });

  client.addCommandCenterItem({
    id: "open-antigravity-telemetry",
    title: "Open Antigravity Usage & Context Telemetry",
    icon: "Gauge",
    keywords: ["antigravity", "agy", "quota", "usage", "tokens", "cost", "context"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("telemetry");
    },
  });

  const maybeAddSlashCommand = (
    client as unknown as {
      addSlashCommand?: PluginClientContext["addSlashCommand"];
    }
  ).addSlashCommand;

  if (typeof maybeAddSlashCommand === "function") {
    maybeAddSlashCommand.call(client, {
      name: "agy-telemetry",
      description: "Open Antigravity session usage, context wheel & quota panel",
      context: "agent",
      async onSubmit({ openPanel }) {
        openPanel("telemetry");
      },
    });
  }

  return contributeAntigravityPills(client);
}
