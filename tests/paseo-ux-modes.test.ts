import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { ACPServer } from "../src/acp-server.js";
import { SessionManager } from "../src/session.js";
import {
  AVAILABLE_MODES,
  AVAILABLE_PERMISSIONS,
  buildConfigOptionsForSession,
  escapeMarkdownUrl,
  formatImageMarkdown,
  extractImageMarkdownLink,
  isNarrationText,
} from "../src/protocol.js";
import { buildAgyArgs, parseExtraArgs, resolvePermissionSettings } from "../src/permissions.js";

describe("Paseo UX Modes & Compatibility Features", () => {
  it("includes accept-edits in AVAILABLE_MODES", () => {
    const ids = AVAILABLE_MODES.map((m) => m.id);
    expect(ids).toContain("default");
    expect(ids).toContain("plan");
    expect(ids).toContain("accept-edits");
  });

  it("includes default, sandbox, and bypass in AVAILABLE_PERMISSIONS", () => {
    const ids = AVAILABLE_PERMISSIONS.map((p) => p.id);
    expect(ids).toEqual(["default", "sandbox", "bypass"]);
  });

  it("buildConfigOptionsForSession creates options for thought_level, mode, and permission", () => {
    const options = buildConfigOptionsForSession({
      modelId: "gemini-3.7-flash",
      currentEffort: "high",
      currentMode: "plan",
      currentPermission: "sandbox",
    });

    expect(options.length).toBe(3);
    expect(options[0].category).toBe("thought_level");
    expect(options[0].currentValue).toBe("high");

    expect(options[1].id).toBe("mode");
    expect(options[1].currentValue).toBe("plan");
    expect(options[1].options.map((o) => o.value)).toContain("accept-edits");

    expect(options[2].id).toBe("permission");
    expect(options[2].currentValue).toBe("sandbox");
    expect(options[2].options.map((o) => o.value)).toContain("bypass");
  });

  describe("AGY_EXTRA_ARGS parsing", () => {
    const originalEnv = process.env.AGY_EXTRA_ARGS;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.AGY_EXTRA_ARGS = originalEnv;
      } else {
        delete process.env.AGY_EXTRA_ARGS;
      }
    });

    it("parses empty or missing AGY_EXTRA_ARGS cleanly", () => {
      expect(parseExtraArgs("")).toEqual([]);
      expect(parseExtraArgs(undefined)).toEqual([]);
      expect(parseExtraArgs("   ")).toEqual([]);
    });

    it("splits space-separated and quoted extra arguments", () => {
      const args = parseExtraArgs('--flag-one --name "my custom value" --port 8080');
      expect(args).toEqual(["--flag-one", "--name", "my custom value", "--port", "8080"]);
    });

    it("injects AGY_EXTRA_ARGS into buildAgyArgs", () => {
      process.env.AGY_EXTRA_ARGS = "--custom-flag --debug-token abc";
      const settings = resolvePermissionSettings();
      const args = buildAgyArgs(settings);

      expect(args).toContain("--custom-flag");
      expect(args).toContain("--debug-token");
      expect(args).toContain("abc");
    });
  });

  describe("Markdown Image Escaping & Linking", () => {
    it("escapes backslashes in Windows paths", () => {
      const escaped = escapeMarkdownUrl("C:\\Users\\Rafael\\Pictures\\chart.png");
      expect(escaped).toBe("C:\\\\Users\\\\Rafael\\\\Pictures\\\\chart.png");
    });

    it("escapes closing parentheses to prevent breaking Markdown links", () => {
      const escaped = escapeMarkdownUrl("/path/to/my screenshot (1).png");
      expect(escaped).toBe("/path/to/my screenshot (1\\).png");
    });

    it("escapes both backslashes and parentheses simultaneously", () => {
      const escaped = escapeMarkdownUrl("C:\\Users\\Rafael\\odd (1)\\photo.jpg");
      expect(escaped).toBe("C:\\\\Users\\\\Rafael\\\\odd (1\\)\\\\photo.jpg");
    });

    it("formats image markdown from bare absolute paths and file URIs", () => {
      const md1 = formatImageMarkdown("/tmp/output.png");
      expect(md1).toBe("![Generated image](/tmp/output.png)");

      const md2 = formatImageMarkdown("file:///tmp/generated.png");
      expect(md2).toBe("![Generated image](/tmp/generated.png)");
    });

    it("extracts image markdown link from tool execution outputs", () => {
      const link1 = extractImageMarkdownLink(
        "generate_image",
        "Image generated successfully at /home/user/images/diagram.png"
      );
      expect(link1).toBe("![Generated image](/home/user/images/diagram.png)");

      const link2 = extractImageMarkdownLink(
        "generate_image",
        { path: "C:\\Users\\Rafael\\result.webp" }
      );
      expect(link2).toBe("![Generated image](C:\\\\Users\\\\Rafael\\\\result.webp)");

      const link3 = extractImageMarkdownLink(
        "generate_image",
        "Done",
        { TargetFile: "/workspace/mockup.png" }
      );
      expect(link3).toBe("![Generated image](/workspace/mockup.png)");
    });
  });

  describe("Narration Detection", () => {
    it("detects conversational narration sentences", () => {
      expect(isNarrationText("I will inspect the file now.")).toBe(true);
      expect(isNarrationText("I'll run the command for you.")).toBe(true);
      expect(isNarrationText("I’ll check the codebase.")).toBe(true);
      expect(isNarrationText("Let me review the repository.")).toBe(true);
      expect(isNarrationText("I am going to check the configuration.")).toBe(true);
    });

    it("returns false for non-narration responses", () => {
      expect(isNarrationText("Here is the updated configuration:\n```json\n{}\n```")).toBe(false);
      expect(isNarrationText("Tests passed successfully.")).toBe(false);
      expect(isNarrationText("")).toBe(false);
    });
  });

  describe("RPC Method Aliases & Config Options via ACPServer", () => {
    let server: ACPServer;
    let clientInput: PassThrough;
    let clientOutput: PassThrough;
    let responses: any[];

    beforeEach(() => {
      clientInput = new PassThrough();
      clientOutput = new PassThrough();
      responses = [];
      clientOutput.setEncoding("utf-8");
      clientOutput.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter((value) => value.trim())) {
          responses.push(JSON.parse(line));
        }
      });
      server = new ACPServer({
        input: clientInput,
        output: clientOutput,
        sessionManager: new SessionManager(),
      });
      server.start();
    });

    afterEach(async () => {
      await server.stop();
    });

    function sendRpc(msg: any) {
      clientInput.write(JSON.stringify(msg) + "\n");
    }

    async function waitForResponse(id: number, timeoutMs = 15000): Promise<any> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const response = responses.find((item) => item.id === id);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timeout waiting for RPC response id=${id}`);
    }

    it("handles session/setMode camelCase alias with accept-edits mode", async () => {
      sendRpc({
        jsonrpc: "2.0",
        id: 10,
        method: "session/new",
        params: { cwd: "/tmp", model: "gemini-3.7-flash" },
      });
      const newSess = await waitForResponse(10);
      const sessionId = newSess.result.sessionId;

      sendRpc({
        jsonrpc: "2.0",
        id: 11,
        method: "session/setMode",
        params: { sessionId, modeId: "accept-edits" },
      });
      const setModeResp = await waitForResponse(11);
      expect(setModeResp.result).toBeDefined();
      expect(setModeResp.error).toBeUndefined();
    });

    it("handles session/setConfigOption camelCase alias to change mode and permission", async () => {
      sendRpc({
        jsonrpc: "2.0",
        id: 20,
        method: "session/new",
        params: { cwd: "/tmp", model: "gemini-3.7-flash" },
      });
      const newSess = await waitForResponse(20);
      const sessionId = newSess.result.sessionId;

      // Update mode via setConfigOption
      sendRpc({
        jsonrpc: "2.0",
        id: 21,
        method: "session/setConfigOption",
        params: { sessionId, configId: "mode", value: "plan" },
      });
      const modeResp = await waitForResponse(21);
      const modeOpt = modeResp.result.configOptions.find((o: any) => o.id === "mode");
      expect(modeOpt.currentValue).toBe("plan");

      // Update permission via setConfigOption
      sendRpc({
        jsonrpc: "2.0",
        id: 22,
        method: "session/setConfigOption",
        params: { sessionId, configId: "permission", value: "bypass" },
      });
      const permResp = await waitForResponse(22);
      const permOpt = permResp.result.configOptions.find((o: any) => o.id === "permission");
      expect(permOpt.currentValue).toBe("bypass");
    });
  });
});
