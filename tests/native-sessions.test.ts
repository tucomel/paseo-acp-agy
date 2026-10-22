import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadNativeAntigravitySessions, getNativeAntigravitySession } from "../src/native-sessions.js";

describe("Native Antigravity Sessions Discovery", () => {
  let tempDir: string;
  let originalAppDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-native-test-"));
    originalAppDataDir = process.env.AGY_APP_DATA_DIR;
    process.env.AGY_APP_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (originalAppDataDir !== undefined) {
      process.env.AGY_APP_DATA_DIR = originalAppDataDir;
    } else {
      delete process.env.AGY_APP_DATA_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers native Antigravity conversations from SQLite database via CLI or DatabaseSync", () => {
    const dbPath = path.join(tempDir, "conversation_summaries.db");

    // Create a mock SQLite database using sqlite3 CLI
    execFileSync(
      "sqlite3",
      [
        dbPath,
        `CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT,
          preview TEXT,
          last_modified_time TEXT,
          workspace_uris TEXT
        );
        INSERT INTO conversation_summaries VALUES (
          'conv-1111-2222',
          'Optimize Search Algorithm',
          'Optimize Search Algorithm',
          '2026-10-22T12:00:00.000Z',
          '["file:///Users/arthur/GIT/search"]'
        );
        INSERT INTO conversation_summaries VALUES (
          'conv-3333-4444',
          'Fix Header Layout',
          'Fix Header Layout',
          '2026-10-22T13:00:00.000Z',
          '["file:///Users/arthur/GIT/web"]'
        );`,
      ],
      { stdio: "ignore" }
    );

    const allSessions = loadNativeAntigravitySessions();
    expect(allSessions.length).toBe(2);

    const first = allSessions.find((s) => s.sessionId === "conv-3333-4444");
    expect(first).toBeDefined();
    expect(first?.title).toBe("Fix Header Layout");
    expect(first?.cwd).toBe(path.resolve("/Users/arthur/GIT/web"));

    // Filter by cwd
    const filtered = loadNativeAntigravitySessions(path.resolve("/Users/arthur/GIT/search"));
    expect(filtered.length).toBe(1);
    expect(filtered[0].sessionId).toBe("conv-1111-2222");

    // Single session lookup
    const single = getNativeAntigravitySession("conv-1111-2222");
    expect(single).toBeDefined();
    expect(single?.title).toBe("Optimize Search Algorithm");
    expect(single?.sessionId).toBe("conv-1111-2222");
  });
});
