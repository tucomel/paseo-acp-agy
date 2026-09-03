import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityProcess } from "../src/antigravity-process.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFakeAgy(options?: { responseDelayMs?: number; spawnGrandchild?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-child-"));
  tempDirs.push(dir);
  const argsLog = path.join(dir, "args.log");
  const promptLog = path.join(dir, "prompts.log");
  const grandchildPidFile = path.join(dir, "grandchild.pid");
  const fakeAgy = path.join(dir, "fake-agy.mjs");
  const responseDelayMs = options?.responseDelayMs ?? 0;

  fs.writeFileSync(
    fakeAgy,
    `#!/usr/bin/env node\n` +
      `import fs from "node:fs";\n` +
      `import { spawn } from "node:child_process";\n` +
      `if (process.env.FAKE_AGY_ARGS) fs.appendFileSync(process.env.FAKE_AGY_ARGS, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `const i = process.argv.indexOf("--conversation");\n` +
      `const conv = i >= 0 ? process.argv[i + 1] : "823fb330-71e5-43b9-9efd-d9b7323e4b94";\n` +
      (options?.spawnGrandchild
        ? `const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n` +
          `if (process.env.FAKE_AGY_GRANDCHILD_PID) fs.writeFileSync(process.env.FAKE_AGY_GRANDCHILD_PID, String(grandchild.pid));\n`
        : ``) +
      `process.stdout.write(JSON.stringify({event:"init",conversation_id:conv,init:{model:"fake"}}) + "\\n");\n` +
      `let buf = ""; process.stdin.setEncoding("utf8");\n` +
      `process.stdin.on("data", chunk => { buf += chunk; const lines = buf.split("\\n"); buf = lines.pop() || ""; for (const line of lines) { if (!line.trim()) continue; const input = JSON.parse(line); if (process.env.FAKE_AGY_PROMPTS) fs.appendFileSync(process.env.FAKE_AGY_PROMPTS, String(input.message?.content || "") + "\\n"); setTimeout(() => process.stdout.write(JSON.stringify({event:"result",result:{conversation_id:conv,status:"SUCCESS",response:"ok"}}) + "\\n"), ${responseDelayMs}); }});\n`,
    { mode: 0o700 }
  );

  return {
    dir,
    fakeAgy,
    argsLog,
    promptLog,
    grandchildPidFile,
    env: {
      FAKE_AGY_ARGS: argsLog,
      FAKE_AGY_PROMPTS: promptLog,
      FAKE_AGY_GRANDCHILD_PID: grandchildPidFile,
    },
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Antigravity subprocess lifecycle", () => {
  it("awaits the old child before spawning a reconfigured process and preserves conversation ID", async () => {
    const fake = makeFakeAgy();
    const adapter = new AntigravityProcess({
      binaryPath: fake.fakeAgy,
      cwd: fake.dir,
      model: "gemini-3.7-flash",
      effort: "high",
      env: fake.env,
    });

    await adapter.sendPrompt("first turn");
    adapter.setModel("gemini-3.6-flash");
    await adapter.sendPrompt("second turn");
    await adapter.close();

    const launches = fs
      .readFileSync(fake.argsLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain("--conversation");
    expect(launches[1]).toContain("823fb330-71e5-43b9-9efd-d9b7323e4b94");
  });

  it("reserves a prompt turn before async startup so a second prompt is rejected", async () => {
    const fake = makeFakeAgy({ responseDelayMs: 50 });
    const adapter = new AntigravityProcess({ binaryPath: fake.fakeAgy, cwd: fake.dir, env: fake.env });

    const first = adapter.sendPrompt("first");
    await expect(adapter.sendPrompt("second")).rejects.toThrow(/already in progress/);
    await first;
    await adapter.close();

    expect(fs.readFileSync(fake.promptLog, "utf8").trim().split("\n")).toEqual(["first"]);
  });

  it("honors cancellation while the first turn is still in startup and never writes the prompt", async () => {
    const fake = makeFakeAgy();
    const adapter = new AntigravityProcess({ binaryPath: fake.fakeAgy, cwd: fake.dir, env: fake.env });

    const turn = adapter.sendPrompt("must not execute");
    expect(adapter.cancelCurrentTurn()).toBe(true);
    await expect(turn).rejects.toThrow(/cancelled before execution/);
    await adapter.close();

    expect(fs.existsSync(fake.promptLog) ? fs.readFileSync(fake.promptLog, "utf8").trim() : "").toBe("");
  });

  it.skipIf(process.platform === "win32")("terminates the whole agy process group, including descendants", async () => {
    const fake = makeFakeAgy({ spawnGrandchild: true });
    const adapter = new AntigravityProcess({ binaryPath: fake.fakeAgy, cwd: fake.dir, env: fake.env });

    await adapter.sendPrompt("spawn tree");
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(fake.grandchildPidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const grandchildPid = Number(fs.readFileSync(fake.grandchildPidFile, "utf8"));
    expect(processExists(grandchildPid)).toBe(true);

    await adapter.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(processExists(grandchildPid)).toBe(false);
  });
});
