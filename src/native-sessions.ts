import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { logger } from "./logger.js";
import { SessionInfo } from "./protocol.js";
import { normalizeCwdForComparison } from "./session-store.js";

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

interface DbSummaryRow {
  conversation_id: string;
  title: string | null;
  preview: string | null;
  last_modified_time: string | null;
  workspace_uris: string | null;
}

function querySummariesDb(dbPath: string, query: string, params: any[] = []): DbSummaryRow[] {
  // 1. Try node:sqlite DatabaseSync (Node 22+)
  try {
    const DatabaseSync = require("node:sqlite")?.DatabaseSync;
    if (DatabaseSync) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      return (db.prepare(query).all(...params) as DbSummaryRow[]) || [];
    }
  } catch {}

  // 2. Try sqlite3 CLI fallback (macOS, Linux with Node < 22)
  try {
    const { execFileSync } = require("node:child_process");
    let finalQuery = query;
    if (params.length === 1 && typeof params[0] === "string") {
      finalQuery = query.replace("?", `'${params[0].replace(/'/g, "''")}'`);
    }
    const stdout = execFileSync("sqlite3", ["-json", dbPath, finalQuery], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (stdout && stdout.trim()) {
      return (JSON.parse(stdout) as DbSummaryRow[]) || [];
    }
  } catch (err) {
    logger.debug("Failed to query conversation summaries via sqlite3 CLI", {
      error: (err as Error).message,
    });
  }

  return [];
}

export function loadNativeAntigravitySessions(cwd?: string): SessionInfo[] {
  const results: SessionInfo[] = [];
  const appDataDir = getAgyAppDataDir();
  const dbPath = path.join(appDataDir, "conversation_summaries.db");

  const normalizedTargetCwd = cwd ? normalizeCwdForComparison(cwd) : undefined;

  if (fs.existsSync(dbPath)) {
    try {
      const rows = querySummariesDb(
        dbPath,
        `SELECT conversation_id, title, preview, last_modified_time, workspace_uris
         FROM conversation_summaries
         ORDER BY last_modified_time DESC
         LIMIT 100`
      );

      for (const row of rows) {
        if (!row.conversation_id) continue;

        let primaryCwd = process.cwd();
        let matchesCwd = false;

        if (row.workspace_uris) {
          try {
            const uris = JSON.parse(row.workspace_uris) as string[];
            if (Array.isArray(uris) && uris.length > 0) {
              const filePaths = uris
                .map((u) => {
                  const cleaned = u.replace(/^file:\/\//i, "");
                  try {
                    return path.resolve(decodeURIComponent(cleaned));
                  } catch {
                    return path.resolve(cleaned);
                  }
                })
                .filter(Boolean);
              if (filePaths.length > 0) {
                primaryCwd = filePaths[0];
              }
              if (normalizedTargetCwd) {
                matchesCwd = filePaths.some(
                  (p) => normalizeCwdForComparison(p) === normalizedTargetCwd
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

  // Fallback: Only scan brainDir if no conversations were found in DB
  if (results.length === 0) {
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
            if (stat.size > 0) {
              results.push({
                sessionId: convId,
                cwd: process.cwd(),
                title: "Antigravity Session",
                updatedAt: stat.mtime.toISOString(),
              });
              if (results.length >= 50) break;
            }
          }
        }
      }
    } catch {}
  }

  return results;
}

export function getNativeAntigravitySession(conversationId: string): SessionInfo | null {
  if (!conversationId) return null;
  const appDataDir = getAgyAppDataDir();
  const dbPath = path.join(appDataDir, "conversation_summaries.db");

  if (fs.existsSync(dbPath)) {
    try {
      const rows = querySummariesDb(
        dbPath,
        `SELECT conversation_id, title, preview, last_modified_time, workspace_uris
         FROM conversation_summaries
         WHERE conversation_id = ?`,
        [conversationId]
      );
      const row = rows[0];

      if (row) {
        let primaryCwd = process.cwd();
        if (row.workspace_uris) {
          try {
            const uris = JSON.parse(row.workspace_uris) as string[];
            if (Array.isArray(uris) && uris.length > 0) {
              const cleaned = uris[0].replace(/^file:\/\//i, "");
              try {
                primaryCwd = path.resolve(decodeURIComponent(cleaned));
              } catch {
                primaryCwd = path.resolve(cleaned);
              }
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

export function clearConversationQuotaErrors(conversationId?: string): boolean {
  if (!conversationId) return false;
  // Ensure valid UUID format to avoid unexpected paths or SQL injection
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
    return false;
  }

  const appDataDir = getAgyAppDataDir();
  const dbPath = path.join(appDataDir, "conversations", `${conversationId}.db`);
  if (!fs.existsSync(dbPath)) {
    return false;
  }

  const sql = `PRAGMA busy_timeout = 3000; UPDATE steps SET step_type = 15 WHERE step_type = 17 AND (CAST(error_details AS TEXT) LIKE '%quota%' OR CAST(error_details AS TEXT) LIKE '%resource_exhausted%' OR CAST(step_payload AS TEXT) LIKE '%quota%' OR CAST(step_payload AS TEXT) LIKE '%resource_exhausted%' OR CAST(render_info AS TEXT) LIKE '%quota%' OR CAST(render_info AS TEXT) LIKE '%resource_exhausted%'); PRAGMA wal_checkpoint(FULL);`;

  // 1. Try node:sqlite DatabaseSync (Node 22+)
  try {
    const DatabaseSync = require("node:sqlite")?.DatabaseSync;
    if (DatabaseSync) {
      const db = new DatabaseSync(dbPath);
      db.exec(sql);
      db.close();
      logger.info("Cleared conversation quota error steps via DatabaseSync", { conversationId });
      return true;
    }
  } catch (err) {
    logger.debug("DatabaseSync clearConversationQuotaErrors error, falling back to sqlite3 CLI", {
      error: (err as Error).message,
    });
  }

  // 2. Try sqlite3 CLI fallback (macOS, Linux)
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    logger.info("Cleared conversation quota error steps via sqlite3 CLI", { conversationId });
    return true;
  } catch (err) {
    logger.debug("Failed to clear conversation quota error steps via sqlite3 CLI", {
      conversationId,
      error: (err as Error).message,
    });
  }

  return false;
}

