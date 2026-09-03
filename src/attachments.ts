import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { logger } from "./logger.js";

const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function getStateRoot(): string {
  if (process.env.AGY_ACP_STATE_DIR) return process.env.AGY_ACP_STATE_DIR;
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "agy-acp");
}

function getAttachmentsDir(): string {
  const attachmentsDir = path.join(getStateRoot(), "attachments");
  try {
    fs.mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(attachmentsDir, 0o700);
  } catch {}
  return attachmentsDir;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

function maxAttachmentBytes(): number {
  const configured = Number.parseInt(process.env.AGY_ACP_MAX_ATTACHMENT_BYTES || "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_ATTACHMENT_BYTES;
}

function normalizeBase64(data: string): string {
  const comma = data.indexOf(",");
  const stripped = data.startsWith("data:") && comma >= 0 ? data.slice(comma + 1) : data;
  return stripped.replace(/\s+/g, "");
}

function decodeValidatedBase64(data: string): Buffer | null {
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const unpadded = data.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  try {
    const buffer = Buffer.from(data, "base64");
    if (buffer.toString("base64").replace(/=+$/, "") !== unpadded) return null;
    return buffer;
  } catch {
    return null;
  }
}

export function saveBase64Image(data: string, mimeType = "image/png"): string | null {
  const normalizedMime = mimeType.toLowerCase();
  const ext = MIME_TO_EXT[normalizedMime];
  if (!ext) {
    logger.warn("Rejected attachment with unsupported MIME type", { mimeType: normalizedMime });
    return null;
  }

  const normalized = normalizeBase64(data);
  const maxBytes = maxAttachmentBytes();
  if (normalized.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    logger.warn("Rejected attachment exceeding configured size limit", {
      encodedLength: normalized.length,
      maxBytes,
    });
    return null;
  }

  const buffer = decodeValidatedBase64(normalized);
  if (!buffer) {
    logger.warn("Rejected attachment with invalid base64 payload");
    return null;
  }
  if (buffer.length === 0 || buffer.length > maxBytes) {
    logger.warn("Rejected attachment outside configured decoded size limit", {
      sizeBytes: buffer.length,
      maxBytes,
    });
    return null;
  }

  const dir = getAttachmentsDir();
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const filePath = path.join(dir, `attachment_${hash}${ext}`);

  if (!fs.existsSync(filePath)) {
    try {
      fs.writeFileSync(filePath, buffer, { mode: 0o600, flag: "wx" });
      fs.chmodSync(filePath, 0o600);
      logger.info("Saved attached image for session", { filePath, sizeBytes: buffer.length });
    } catch (err) {
      if (!fs.existsSync(filePath)) {
        logger.error("Failed to save attached image", { error: (err as Error).message });
        return null;
      }
    }
  }

  return filePath;
}
