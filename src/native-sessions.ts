import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { logger } from "./logger.js";
import { SessionInfo } from "./protocol.js";

const require = createRequire(import.meta.url);

export function getAgyAppDataDir(): string {
  if (process.env.AGY_APP_DATA_DIR) {
    return process.env.AGY_APP_DATA_DIR;
  }
  if (process.env.AGY_BRAIN_DIR) {
    return path.dirname(process.env.AGY_BRAIN_DIR);
  }
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

export function loadNativeAntigravitySessions(cwd?: string): SessionInfo[] {
  const results: SessionInfo[] = [];
  const appDataDir = getAgyAppDataDir();
  const dbPath = path.join(appDataDir, "conversation_summaries.db");

  const normalizedTargetCwd = cwd ? path.resolve(cwd).toLowerCase() : undefined;

  if (fs.existsSync(dbPath)) {
    let DatabaseSync: any = null;
    try {
      DatabaseSync = require("node:sqlite")?.DatabaseSync;
    } catch {}

    if (DatabaseSync) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db
          .prepare(
            `SELECT conversation_id, title, preview, last_modified_time, workspace_uris
             FROM conversation_summaries
             ORDER BY last_modified_time DESC
             LIMIT 200`
          )
          .all() as Array<{
            conversation_id: string;
            title: string | null;
            preview: string | null;
            last_modified_time: string | null;
            workspace_uris: string | null;
          }>;

        for (const row of rows) {
          if (!row.conversation_id) continue;

          let primaryCwd = process.cwd();
          let matchesCwd = false;

          if (row.workspace_uris) {
            try {
              const uris = JSON.parse(row.workspace_uris) as string[];
              if (Array.isArray(uris) && uris.length > 0) {
                const filePaths = uris
                  .map((u) => u.replace(/^file:\/\//i, ""))
                  .filter(Boolean);
                if (filePaths.length > 0) {
                  primaryCwd = filePaths[0];
                }
                if (normalizedTargetCwd) {
                  matchesCwd = filePaths.some(
                    (p) => path.resolve(p).toLowerCase() === normalizedTargetCwd
                  );
                }
              }
            } catch {}
          }

          if (normalizedTargetCwd && !matchesCwd) {
            continue;
          }

          const rawDate = row.last_modified_time;
          const dateIso = rawDate ? new Date(rawDate).toISOString() : undefined;

          results.push({
            sessionId: row.conversation_id,
            cwd: primaryCwd,
            title:
              (row.title && row.title.trim()) ||
              (row.preview && row.preview.trim()) ||
              "Antigravity Session",
            updatedAt: dateIso,
          });
        }
      } catch (err) {
        logger.debug("Failed to read native conversation summaries from sqlite", {
          error: (err as Error).message,
        });
      }
    }
  }

  // Fallback: Also scan brainDir for any conversation not in DB
  try {
    const brainDir = path.join(appDataDir, "brain");
    if (fs.existsSync(brainDir)) {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const convId = entry.name;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(convId)) {
          continue;
        }
        if (results.some((r) => r.sessionId === convId)) continue;

        const transcriptPath = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
        if (fs.existsSync(transcriptPath)) {
          const stat = fs.statSync(transcriptPath);
          results.push({
            sessionId: convId,
            cwd: process.cwd(),
            title: "Antigravity Session",
            updatedAt: stat.mtime.toISOString(),
          });
        }
      }
    }
  } catch {}

  return results;
}

export function getNativeAntigravitySession(conversationId: string): SessionInfo | null {
  if (!conversationId) return null;
  const appDataDir = getAgyAppDataDir();
  const dbPath = path.join(appDataDir, "conversation_summaries.db");

  if (fs.existsSync(dbPath)) {
    let DatabaseSync: any = null;
    try {
      DatabaseSync = require("node:sqlite")?.DatabaseSync;
    } catch {}

    if (DatabaseSync) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db
          .prepare(
            `SELECT conversation_id, title, preview, last_modified_time, workspace_uris
             FROM conversation_summaries
             WHERE conversation_id = ?`
          )
          .get(conversationId) as
          | {
              conversation_id: string;
              title: string | null;
              preview: string | null;
              last_modified_time: string | null;
              workspace_uris: string | null;
            }
          | undefined;

        if (row) {
          let primaryCwd = process.cwd();
          if (row.workspace_uris) {
            try {
              const uris = JSON.parse(row.workspace_uris) as string[];
              if (Array.isArray(uris) && uris.length > 0) {
                const p = uris[0].replace(/^file:\/\//i, "");
                if (p) primaryCwd = p;
              }
            } catch {}
          }
          return {
            sessionId: row.conversation_id,
            cwd: primaryCwd,
            title:
              (row.title && row.title.trim()) ||
              (row.preview && row.preview.trim()) ||
              "Antigravity Session",
            updatedAt: row.last_modified_time
              ? new Date(row.last_modified_time).toISOString()
              : undefined,
          };
        }
      } catch {}
    }
  }

  // Fallback check transcript file
  const brainDir = path.join(appDataDir, "brain", conversationId);
  const transcriptPath = path.join(brainDir, ".system_generated", "logs", "transcript.jsonl");
  if (fs.existsSync(transcriptPath)) {
    const stat = fs.statSync(transcriptPath);
    return {
      sessionId: conversationId,
      cwd: process.cwd(),
      title: "Antigravity Session",
      updatedAt: stat.mtime.toISOString(),
    };
  }

  return null;
}
