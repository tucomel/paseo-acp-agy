import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACP_METHODS } from "../src/protocol.js";
import { SessionManager } from "../src/session.js";
import { SessionStore } from "../src/session-store.js";
import { saveBase64Image } from "../src/attachments.js";
import { resolveTargetConversationId } from "../src/slash-commands.js";

describe("agy-acp hardening", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-hardening-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses ACP snake_case wire methods while retaining pre-hardening aliases", () => {
    expect(ACP_METHODS.SESSION_SET_MODE).toBe("session/set_mode");
    expect(ACP_METHODS.SESSION_SET_MODEL).toBe("session/set_model");
    expect(ACP_METHODS.SESSION_SET_CONFIG_OPTION).toBe("session/set_config_option");
    expect(ACP_METHODS.SESSION_SET_MODE_ALIAS).toBe("setSessionMode");
    expect(ACP_METHODS.SESSION_SET_MODEL_ALIAS).toBe("unstable_setSessionModel");
    expect(ACP_METHODS.SESSION_SET_CONFIG_OPTION_ALIAS).toBe("setSessionConfigOption");
  });

  it("persists ACP session metadata and Antigravity conversation IDs", () => {
    const store = new SessionStore(path.join(tempDir, "sessions"));
    const first = new SessionManager({ store }).createSession({
      cwd: "/tmp/workspace",
      model: "gemini-3.7-flash",
      effort: "high",
      conversationId: "823fb330-71e5-43b9-9efd-d9b7323e4b94",
    });
    first.setEffort("low");

    const restored = new SessionManager({ store }).createSession({ id: first.id });
    expect(restored.cwd).toBe("/tmp/workspace");
    expect(restored.effort).toBe("low");
    expect(restored.process.currentConversationId).toBe(
      "823fb330-71e5-43b9-9efd-d9b7323e4b94"
    );
  });

  it("fails closed when asked to restore an unknown ACP session", () => {
    const store = new SessionStore(path.join(tempDir, "sessions"));
    const manager = new SessionManager({ store });
    expect(() => manager.createSession({ id: "missing-session-123456" })).toThrow(
      /unknown ACP session/
    );
  });

  it("rejects unsafe resume identifiers and malformed or unsupported attachments", () => {
    expect(resolveTargetConversationId("../../../etc/passwd")).toBeNull();
    expect(resolveTargetConversationId("/etc/passwd")).toBeNull();
    expect(saveBase64Image("not-base64***", "image/png")).toBeNull();
    expect(saveBase64Image("aGVsbG8=", "application/octet-stream")).toBeNull();
    expect(saveBase64Image("A", "image/png")).toBeNull();
  });
});
