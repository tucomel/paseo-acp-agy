import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getLogDir(): string {
  if (process.env.AGY_ACP_LOG_DIR) {
    return process.env.AGY_ACP_LOG_DIR;
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "agy-acp");
}

function resolveLogLevel(): LogLevel {
  const envLevel = process.env.AGY_ACP_LOG_LEVEL?.toLowerCase();
  if (envLevel === "debug" || envLevel === "info" || envLevel === "warn" || envLevel === "error") {
    return envLevel;
  }
  return "info";
}

export function sanitizeString(str: string): string {
  return str
    .replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]{8,}/gi, "$1[REDACTED]")
    .replace(
      /(token|key|secret|password|auth|authorization|api[_-]?key)(\s*[:=]\s*['"]?)[a-zA-Z0-9_\-\.]{6,}(['"]?)/gi,
      "$1$2[REDACTED]$3"
    )
    .replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_API_KEY]")
    .replace(/ya29\.[0-9A-Za-z-_]+/g, "[REDACTED_OAUTH_TOKEN]");
}

export function sanitize(data: unknown): unknown {
  if (typeof data === "string") {
    return sanitizeString(data);
  }
  if (data && typeof data === "object") {
    if (Array.isArray(data)) {
      return data.map(sanitize);
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (/token|secret|password|cookie|credential|authorization|api[_-]?key/i.test(k)) {
        clean[k] = typeof v === "object" && v !== null ? sanitize(v) : "[REDACTED]";
      } else {
        clean[k] = sanitize(v);
      }
    }
    return clean;
  }
  return data;
}

export class Logger {
  public logFilePath: string;
  private minLevel: LogLevel;
  private writeStream: fs.WriteStream | null = null;

  constructor(options?: { minLevel?: LogLevel; logDir?: string }) {
    this.minLevel = options?.minLevel || resolveLogLevel();
    const dir = options?.logDir || getLogDir();
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {}
    } catch {}

    this.logFilePath = path.join(dir, "agy-acp.log");
    try {
      // Ensure file exists with 0600 mode
      if (!fs.existsSync(this.logFilePath)) {
        fs.writeFileSync(this.logFilePath, "", { mode: 0o600 });
      } else {
        try {
          fs.chmodSync(this.logFilePath, 0o600);
        } catch {}
      }
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: "a", mode: 0o600 });
      this.writeStream.on("error", () => {});
    } catch {
      this.writeStream = null;
    }
  }

  private log(level: LogLevel, message: string, meta?: unknown) {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const sanitizedMeta = meta !== undefined ? sanitize(meta) : undefined;
    const entry = {
      timestamp,
      level,
      message: sanitizeString(message),
      ...(sanitizedMeta !== undefined ? { data: sanitizedMeta } : {}),
    };

    const line = JSON.stringify(entry) + "\n";
    if (this.writeStream) {
      this.writeStream.write(line);
    }

    if (process.env.AGY_ACP_STDERR_LOG === "true" || process.env.AGY_ACP_STDERR_LOG === "1") {
      process.stderr.write(
        `[agy-acp] ${timestamp} [${level.toUpperCase()}] ${entry.message} ${
          meta ? JSON.stringify(sanitizedMeta) : ""
        }\n`
      );
    }
  }

  debug(message: string, meta?: unknown) {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: unknown) {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: unknown) {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: unknown) {
    this.log("error", message, meta);
  }

  close() {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}

export const logger = new Logger();
