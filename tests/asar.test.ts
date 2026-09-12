import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractAll, createPackage, listPackage } from "../src/asar.js";

describe("ASAR pure TypeScript implementation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-asar-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should pack a directory and list its contents", async () => {
    const srcDir = path.join(tempDir, "source");
    fs.mkdirSync(path.join(srcDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, "hello.txt"), "Hello, ASAR world!");
    fs.writeFileSync(path.join(srcDir, "sub", "nested.json"), JSON.stringify({ ok: true }));

    const asarFile = path.join(tempDir, "test.asar");
    await createPackage(srcDir, asarFile);

    expect(fs.existsSync(asarFile)).toBe(true);
    expect(fs.statSync(asarFile).size).toBeGreaterThan(0);

    const fileList = listPackage(asarFile);
    expect(fileList).toContain("/hello.txt");
    expect(fileList).toContain("/sub/nested.json");
  });

  it("should pack and extract files with byte-for-byte fidelity", async () => {
    const srcDir = path.join(tempDir, "source");
    fs.mkdirSync(path.join(srcDir, "dir1", "dir2"), { recursive: true });

    const txtContent = "Text content with special characters: ü, õ, \u0000, 🚀";
    const binContent = Buffer.from([0x00, 0xff, 0x42, 0x13, 0x37, 0x89, 0xab, 0xcd]);
    const emptyContent = "";

    fs.writeFileSync(path.join(srcDir, "sample.txt"), txtContent, "utf8");
    fs.writeFileSync(path.join(srcDir, "dir1", "sample.bin"), binContent);
    fs.writeFileSync(path.join(srcDir, "dir1", "dir2", "empty.txt"), emptyContent);

    const asarFile = path.join(tempDir, "roundtrip.asar");
    await createPackage(srcDir, asarFile);

    const destDir = path.join(tempDir, "extracted");
    extractAll(asarFile, destDir);

    expect(fs.readFileSync(path.join(destDir, "sample.txt"), "utf8")).toBe(txtContent);
    expect(fs.readFileSync(path.join(destDir, "dir1", "sample.bin"))).toEqual(binContent);
    expect(fs.readFileSync(path.join(destDir, "dir1", "dir2", "empty.txt"), "utf8")).toBe("");
  });

  it("should handle single files and deep hierarchies", async () => {
    const srcDir = path.join(tempDir, "deep");
    const deepDir = path.join(srcDir, "a", "b", "c", "d");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, "deep.js"), 'console.log("deep");');

    const asarFile = path.join(tempDir, "deep.asar");
    await createPackage(srcDir, asarFile);

    const fileList = listPackage(asarFile);
    expect(fileList).toContain("/a/b/c/d/deep.js");

    const outDir = path.join(tempDir, "deep-out");
    extractAll(asarFile, outDir);
    expect(fs.readFileSync(path.join(outDir, "a", "b", "c", "d", "deep.js"), "utf8")).toBe(
      'console.log("deep");'
    );
  });
});
