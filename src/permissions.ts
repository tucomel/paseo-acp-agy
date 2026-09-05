// Permission and security settings for Antigravity ACP adapter

export interface PermissionSettings {
  sandbox: boolean;
  dangerouslySkipPermissions: boolean;
  mode?: string;
  addDirs?: string[];
  printTimeout?: string;
}

export function resolvePermissionSettings(options?: {
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  mode?: string;
  addDirs?: string[];
  printTimeout?: string;
}): PermissionSettings {
  const envSandbox = process.env.AGY_ACP_SANDBOX;
  const envSkipPerms = process.env.AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS;
  const envPrintTimeout = process.env.AGY_ACP_PRINT_TIMEOUT;

  const sandbox = options?.sandbox ?? (envSandbox === "true" || envSandbox === "1");
  // In ACP mode, permissions and tool approvals are governed by the host application (e.g. Paseo).
  // Because agy runs non-interactively over stream-json pipes without an interactive TTY, agy's
  // internal terminal prompts cannot query the user and will fail with "user denied permission".
  // Therefore, dangerouslySkipPermissions defaults to true unless explicitly disabled.
  const dangerouslySkipPermissions =
    options?.dangerouslySkipPermissions ??
    (envSkipPerms !== undefined ? envSkipPerms === "true" || envSkipPerms === "1" : true);
  // Default printTimeout to 24h (or env override) so that agy never terminates long turns prematurely
  const printTimeout = options?.printTimeout ?? envPrintTimeout ?? "24h";

  return {
    sandbox,
    dangerouslySkipPermissions,
    mode: options?.mode,
    addDirs: options?.addDirs,
    printTimeout,
  };
}

export function buildAgyArgs(settings: PermissionSettings, extraArgs?: string[]): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print="];

  if (settings.printTimeout) {
    args.push("--print-timeout", settings.printTimeout);
  }

  if (settings.sandbox) {
    args.push("--sandbox");
  }

  if (settings.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (settings.mode && settings.mode !== "default") {
    args.push("--mode", settings.mode);
  }

  if (settings.addDirs && settings.addDirs.length > 0) {
    for (const dir of settings.addDirs) {
      if (dir) {
        args.push("--add-dir", dir);
      }
    }
  }

  if (extraArgs && extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  return args;
}

