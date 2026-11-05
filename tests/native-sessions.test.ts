import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadNativeAntigravitySessions,
  getNativeAntigravitySession,
  clearConversationQuotaErrors,
} from "../src/native-sessions.js";

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

    // Create a mock SQLite database using DatabaseSync or sqlite3 CLI
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE conversation_summaries (
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
        );`);
      db.close();
    } catch {
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
    }

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

  it("clears conversation quota error steps from conversation SQLite database", () => {
    const convId = "4abcfa99-8b28-44a5-8cc4-63fb9fa1a7a3";
    const convsDir = path.join(tempDir, "conversations");
    fs.mkdirSync(convsDir, { recursive: true });
    const dbPath = path.join(convsDir, `${convId}.db`);

    const initSql = `
      CREATE TABLE steps (
        idx integer PRIMARY KEY,
        step_type integer NOT NULL DEFAULT 0,
        status integer NOT NULL DEFAULT 0,
        error_details blob,
        step_payload blob,
        render_info blob
      );
      INSERT INTO steps (idx, step_type, status, error_details) VALUES (
        1,
        17,
        3,
        'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription.'
      );
      INSERT INTO steps (idx, step_type, status, error_details) VALUES (
        2,
        17,
        3,
        'TypeError: Cannot read properties of undefined'
      );
    `;

    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(initSql);
      db.close();
    } catch {
      execFileSync("sqlite3", [dbPath, initSql], { stdio: "ignore" });
    }

    // Invalid UUID is rejected
    expect(clearConversationQuotaErrors("invalid-id")).toBe(false);

    // Valid conversation clears quota error step
    const result = clearConversationQuotaErrors(convId);
    expect(result).toBe(true);

    // Verify step 1 was updated to step_type 15 and step 2 remains 17
    let rows: any[] = [];
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      rows = db.prepare("SELECT idx, step_type FROM steps ORDER BY idx ASC").all();
      db.close();
    } catch {
      const out = execFileSync(
        "sqlite3",
        ["-json", dbPath, "SELECT idx, step_type FROM steps ORDER BY idx ASC"],
        { encoding: "utf-8" }
      );
      rows = JSON.parse(out);
    }

    expect(rows).toEqual([
      { idx: 1, step_type: 15 },
      { idx: 2, step_type: 17 },
    ]);
  });
});
