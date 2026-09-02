import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { logger } from "./logger.js";

function getAttachmentsDir(): string {
  const baseDir =
    process.env.AGY_ACP_LOG_DIR ||
    process.env.XDG_STATE_HOME ||
    path.join(os.homedir(), ".local", "state", "agy-acp");
  const attachmentsDir = path.join(baseDir, "attachments");
  try {
    fs.mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(attachmentsDir, 0o700);
    } catch {}
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

export function saveBase64Image(data: string, mimeType: string = "image/png"): string {
  const dir = getAttachmentsDir();
  const ext = MIME_TO_EXT[mimeType.toLowerCase()] || ".png";
  const hash = crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
  const filePath = path.join(dir, `attachment_${hash}${ext}`);

  if (!fs.existsSync(filePath)) {
    try {
      const buffer = Buffer.from(data, "base64");
      fs.writeFileSync(filePath, buffer, { mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {}
      logger.info("Saved attached image for session", { filePath, sizeBytes: buffer.length });
    } catch (err) {
      logger.error("Failed to save attached image", { error: (err as Error).message });
    }
  }

  return filePath;
}
