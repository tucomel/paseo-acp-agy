import { describe, it, expect, vi } from "vitest";
import { McpBridge } from "../src/mcp-bridge.js";

describe("McpBridge", () => {
  it("syncs stdio and http servers cleanly without throwing", async () => {
    const bridge = new McpBridge("fake-agy");
    // Mock private addServer to test deduplication and argument dispatch
    const addServerSpy = vi.spyOn(bridge as any, "addServer").mockResolvedValue(undefined);

    await bridge.syncServers({
      postgres: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        env: { PG_USER: "postgres" },
      },
      api: {
        type: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer test-token" },
      },
    });

    expect(addServerSpy).toHaveBeenCalledTimes(2);

    // Calling syncServers again with the same config should deduplicate
    await bridge.syncServers({
      postgres: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        env: { PG_USER: "postgres" },
      },
    });

    expect(addServerSpy).toHaveBeenCalledTimes(2);
  });

  it("handles null/undefined servers gracefully", async () => {
    const bridge = new McpBridge("fake-agy");
    await expect(bridge.syncServers(undefined)).resolves.not.toThrow();
  });
});
