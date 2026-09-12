import fs from "node:fs";
import path from "node:path";

export interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string;
  executable?: boolean;
  unpacked?: boolean;
}

/**
 * Reads and parses the ASAR archive header and returns the root node and base offset for data.
 */
export function readArchiveHeader(archivePath: string): { header: AsarNode; dataBaseOffset: number } {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`ASAR archive not found: ${archivePath}`);
  }

  const fd = fs.openSync(archivePath, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, sizeBuf, 0, 8, 0);
    if (bytesRead < 8) {
      throw new Error(`Invalid ASAR archive: file too small (${bytesRead} bytes)`);
    }

    const payloadSize = sizeBuf.readUInt32LE(0);
    const headerSize = sizeBuf.readUInt32LE(4);
    if (payloadSize !== 4 || headerSize <= 0) {
      throw new Error(
        `Invalid ASAR archive header size: payloadSize=${payloadSize}, headerSize=${headerSize}`
      );
    }

    const headerPickleBuf = Buffer.alloc(headerSize);
    const headerRead = fs.readSync(fd, headerPickleBuf, 0, headerSize, 8);
    if (headerRead < headerSize) {
      throw new Error(`Truncated ASAR header: expected ${headerSize} bytes, got ${headerRead}`);
    }

    const strLen = headerPickleBuf.readUInt32LE(4);
    const jsonStr = headerPickleBuf.subarray(8, 8 + strLen).toString("utf8");
    const header: AsarNode = JSON.parse(jsonStr);
    const dataBaseOffset = 8 + headerSize;

    return { header, dataBaseOffset };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Lists all file paths inside an ASAR archive.
 */
export function listPackage(archivePath: string): string[] {
  const { header } = readArchiveHeader(archivePath);
  const result: string[] = [];

  function walk(node: AsarNode, currentPrefix: string) {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) {
        const next = currentPrefix ? `${currentPrefix}/${name}` : `/${name}`;
        walk(child, next);
      }
    } else {
      result.push(currentPrefix);
    }
  }

  walk(header, "");
  return result;
}

/**
 * Pure TypeScript, zero-dependency ASAR archive extractor.
 * Compatible with all Node.js versions (Node 18, 20, 22, 24+) across Windows, macOS, and Linux.
 */
export function extractAll(archivePath: string, destDir: string): void {
  const { header, dataBaseOffset } = readArchiveHeader(archivePath);
  const fd = fs.openSync(archivePath, "r");
  try {
    function extractNode(node: AsarNode, currentPath: string, relParts: string[] = []) {
      if (node.files) {
        fs.mkdirSync(currentPath, { recursive: true });
        for (const [name, child] of Object.entries(node.files)) {
          extractNode(child, path.join(currentPath, name), [...relParts, name]);
        }
      } else if (node.size !== undefined && node.offset !== undefined) {
        const fileOffset = dataBaseOffset + parseInt(node.offset, 10);
        const fileBuf = Buffer.alloc(node.size);
        if (node.size > 0) {
          fs.readSync(fd, fileBuf, 0, node.size, fileOffset);
        }
        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.writeFileSync(currentPath, fileBuf, {
          mode: node.executable ? 0o755 : 0o644,
        });
      } else if (node.unpacked) {
        const unpackedSrc = path.join(archivePath + ".unpacked", ...relParts);
        if (fs.existsSync(unpackedSrc)) {
          fs.mkdirSync(path.dirname(currentPath), { recursive: true });
          fs.copyFileSync(unpackedSrc, currentPath);
        }
      }
    }

    extractNode(header, destDir);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Pure TypeScript, zero-dependency ASAR archive builder.
 * Compatible with all Node.js versions (Node 18, 20, 22, 24+) across Windows, macOS, and Linux.
 */
export async function createPackage(srcDir: string, destFile: string): Promise<void> {
  const files: { relPath: string; fullPath: string; size: number; executable?: boolean }[] = [];

  function walk(dir: string, rel = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const entryRel = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, entryRel);
      } else if (e.isFile()) {
        const stat = fs.statSync(full);
        const executable = Boolean(stat.mode & 0o111);
        files.push({
          relPath: entryRel,
          fullPath: full,
          size: stat.size,
          executable: executable || undefined,
        });
      }
    }
  }

  walk(srcDir);

  const header: AsarNode = { files: {} };
  let currentOffset = 0;

  for (const f of files) {
    const parts = f.relPath.split("/");
    let curr = header.files!;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!curr[parts[i]]) {
        curr[parts[i]] = { files: {} };
      }
      curr = curr[parts[i]].files!;
    }
    const leaf = parts[parts.length - 1];
    curr[leaf] = {
      size: f.size,
      offset: String(currentOffset),
      executable: f.executable,
    };
    currentOffset += f.size;
  }

  const jsonBuf = Buffer.from(JSON.stringify(header), "utf8");
  const alignedJsonLen = (jsonBuf.length + 3) & ~3;
  const headerPayloadSize = 4 + alignedJsonLen;

  // Header pickle: payloadSize (uint32LE) + stringLength (uint32LE) + json bytes (padded to multiple of 4)
  const headerPickle = Buffer.alloc(4 + headerPayloadSize, 0);
  headerPickle.writeUInt32LE(headerPayloadSize, 0);
  headerPickle.writeUInt32LE(jsonBuf.length, 4);
  jsonBuf.copy(headerPickle, 8);

  // Size pickle: 4 (uint32LE payload size) + headerPickle.length (uint32LE)
  const sizePickle = Buffer.alloc(8, 0);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);

  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const fd = fs.openSync(destFile, "w");
  try {
    fs.writeSync(fd, sizePickle);
    fs.writeSync(fd, headerPickle);

    for (const f of files) {
      if (f.size > 0) {
        const content = fs.readFileSync(f.fullPath);
        fs.writeSync(fd, content);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}
