import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const QUALITY_GATES = [
  "type",
  "lint",
  "unit",
  "build",
  "contract",
  "dependency-boundary",
  "basic-security",
];

function defaultCommands() {
  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) {
    return null;
  }
  return QUALITY_GATES.map((gate) => ({
    args: [packageManagerCli, gate],
    command: process.execPath,
    gate,
  }));
}

export function runArchitectureRequired(commands = defaultCommands(), options = {}) {
  if (commands === null) {
    console.error(
      "package.json: architecture-required must be invoked through pnpm. Fix: run 'pnpm architecture-required'.",
    );
    return 1;
  }

  for (const command of commands) {
    const result = spawnSync(command.command, command.args, {
      env: process.env,
      stdio: options.stdio ?? "inherit",
    });
    if (result.status !== 0) {
      console.error(
        `architecture-required: '${command.gate}' failed. Fix: resolve that gate before retrying the aggregate check.`,
      );
      return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runArchitectureRequired();
}
