import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sanitizeString, sanitize, Logger } from "../src/logger.js";

describe("Logger Security & Sanitization", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-log-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should never leak secrets in string sanitization", () => {
    const raw1 = "token=abcdefghijk123456";
    const sanitized1 = sanitizeString(raw1);
    expect(sanitized1).not.toContain("abcdefghijk123456");
    expect(sanitized1).toBe("token=[REDACTED]");

    const raw2 = "Bearer ya29.a0AfH6SMA_secret_token_value_123456789";
    const sanitized2 = sanitizeString(raw2);
    expect(sanitized2).not.toContain("secret_token_value");
    expect(sanitized2).toContain("[REDACTED");

    const raw3 = "password: 'supersecretpassword123'";
    const sanitized3 = sanitizeString(raw3);
    expect(sanitized3).not.toContain("supersecretpassword123");
    expect(sanitized3).toContain("[REDACTED]");
  });

  it("should sanitize nested objects and redact sensitive keys", () => {
    const obj = {
      user: "alice",
      token: "secret123456",
      auth: {
        apiKey: "AIzaSyD-1234567890abcdefghijklmnopqrstuvw",
        details: "authorization: Bearer mysecretkey9999",
      },
    };

    const clean = sanitize(obj) as any;
    expect(clean.user).toBe("alice");
    expect(clean.token).toBe("[REDACTED]");
    expect(clean.auth.apiKey).toBe("[REDACTED]");
    expect(clean.auth.details).not.toContain("mysecretkey9999");
  });

  it("should create log file with 0600 permissions and directory with 0700 permissions", () => {
    const testLogDir = path.join(tempDir, "logs");
    const testLogger = new Logger({ logDir: testLogDir });
    testLogger.info("Test log entry");
    testLogger.close();

    const dirStat = fs.statSync(testLogDir);
    const fileStat = fs.statSync(testLogger.logFilePath);

    // Check directory mode (0700)
    const dirMode = dirStat.mode & 0o777;
    expect(dirMode).toBe(0o700);

    // Check file mode (0600)
    const fileMode = fileStat.mode & 0o777;
    expect(fileMode).toBe(0o600);
  });
});
