// Permission and security settings for Antigravity ACP adapter

export interface PermissionSettings {
  sandbox: boolean;
  dangerouslySkipPermissions: boolean;
  mode?: string;
}

export function resolvePermissionSettings(options?: {
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  mode?: string;
}): PermissionSettings {
  const envSandbox = process.env.AGY_ACP_SANDBOX;
  const envSkipPerms = process.env.AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS;

  const sandbox = options?.sandbox ?? (envSandbox === "true" || envSandbox === "1");
  // Never default to skip permissions; must be explicit
  const dangerouslySkipPermissions =
    options?.dangerouslySkipPermissions ?? (envSkipPerms === "true" || envSkipPerms === "1");

  return {
    sandbox,
    dangerouslySkipPermissions,
    mode: options?.mode,
  };
}

export function buildAgyArgs(settings: PermissionSettings, extraArgs?: string[]): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print="];

  if (settings.sandbox) {
    args.push("--sandbox");
  }

  if (settings.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (settings.mode && settings.mode !== "default") {
    args.push("--mode", settings.mode);
  }

  if (extraArgs && extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  return args;
}
