import { spawn } from "node:child_process";

import { requiresWindowsCommandShell, type AllowlistedCommand } from "./service-commands.ts";

export function spawnProjectCommand(command: AllowlistedCommand, environment: NodeJS.ProcessEnv, stdin: "ignore" | "pipe" = "ignore") {
  const shell = requiresWindowsCommandShell(command.executable);
  const executable = shell ? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" : command.executable;
  const args = shell ? ["/d", "/s", "/c", command.executable, ...command.args] : command.args;
  return spawn(/* turbopackIgnore: true */ executable, args, {
    cwd: command.cwd,
    env: environment,
    stdio: [stdin, "pipe", "pipe"],
    windowsHide: true,
  });
}
