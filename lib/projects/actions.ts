import "server-only";

import { spawn } from "node:child_process";

import type { RepositoryActionResult } from "./action-types";
import {
  discoverCursor,
  discoverIntelliJ,
  discoverPowerShell,
  discoverWindowsTerminal,
  discoveryFailure,
  launchWindowsTool,
} from "./windows-tools";
import type { PackageManager, ProjectScript, Repository } from "@/lib/workspace/types";

const MAX_OUTPUT_CHARS = 24_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;

function cleanOutput(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function outputExcerpt(output: string) {
  return cleanOutput(output).trim().split("\n").slice(-40).join("\n").slice(-MAX_OUTPUT_CHARS);
}

function localActionUnavailable(): RepositoryActionResult {
  return { status: "error", message: "This local action is currently supported on Windows only." };
}

export async function openInCursor(repository: Repository): Promise<RepositoryActionResult> {
  if (process.platform !== "win32") return localActionUnavailable();
  const discovery = await discoverCursor();
  if (!discovery.candidate) return { status: "error", message: discoveryFailure("Cursor", discovery.attempts) };

  try {
    await launchWindowsTool(discovery.candidate, [repository.path], repository.path);
    return { status: "success", message: "Opened this repository in Cursor." };
  } catch {
    return { status: "error", message: `Cursor was found via ${discovery.candidate.source}, but its process could not be launched.` };
  }
}

export async function openInIntelliJ(repository: Repository): Promise<RepositoryActionResult> {
  if (process.platform !== "win32") return localActionUnavailable();
  const discovery = await discoverIntelliJ();
  if (!discovery.candidate) return { status: "error", message: discoveryFailure("IntelliJ IDEA", discovery.attempts) };

  try {
    await launchWindowsTool(discovery.candidate, [repository.path], repository.path);
    return { status: "success", message: "Opened this repository in IntelliJ IDEA." };
  } catch {
    return { status: "error", message: `IntelliJ IDEA was found via ${discovery.candidate.source}, but its process could not be launched.` };
  }
}

export async function openInExplorer(repository: Repository): Promise<RepositoryActionResult> {
  if (process.platform !== "win32") return localActionUnavailable();
  try {
    await launchWindowsTool({ executable: "explorer.exe", source: "Windows" }, [repository.path], repository.path);
    return { status: "success", message: "Opened this repository in Explorer." };
  } catch {
    return { status: "error", message: "Windows Explorer could not be opened." };
  }
}

export async function openTerminal(repository: Repository): Promise<RepositoryActionResult> {
  if (process.platform !== "win32") return localActionUnavailable();
  const terminal = await discoverWindowsTerminal();
  if (terminal.candidate) {
    try {
      await launchWindowsTool(terminal.candidate, ["-d", repository.path], repository.path);
      return { status: "success", message: "Opened terminal at this repository." };
    } catch {
      // Fall back to a visible PowerShell window.
    }
  }

  const powershell = await discoverPowerShell();
  if (!powershell.candidate) {
    return {
      status: "error",
      message: discoveryFailure("A terminal", [...terminal.attempts, ...powershell.attempts]),
    };
  }
  try {
    await launchWindowsTool(powershell.candidate, ["-NoExit"], repository.path);
    return { status: "success", message: "Opened terminal at this repository." };
  } catch {
    return { status: "error", message: "Windows Terminal and PowerShell could not be launched." };
  }
}

function packageCheckCommand(packageManager: PackageManager, script: ProjectScript) {
  const executable = `${packageManager}${process.platform === "win32" ? ".cmd" : ""}`;
  return { executable, args: packageManager === "npm" ? ["run", script] : [script] };
}

async function executeAllowlisted(repository: Repository, executable: string, args: string[]): Promise<RepositoryActionResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const command = process.platform === "win32" && executable.endsWith(".cmd")
      ? { executable: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", executable, ...args] }
      : { executable, args };
    const child = spawn(/* turbopackIgnore: true */ command.executable, command.args, {
      cwd: repository.path,
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const append = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT_CHARS);
    };
    const finish = (result: RepositoryActionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({
        status: "error",
        message: "The check exceeded the 10 minute safety timeout.",
        durationMs: Math.round(performance.now() - started),
        exitCode: null,
        output: outputExcerpt(output),
      });
    }, CHECK_TIMEOUT_MS);

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish({
      status: "error",
      message: "The predefined check could not be started.",
      durationMs: Math.round(performance.now() - started),
      exitCode: null,
      output: outputExcerpt(`${output}\n${error.message}`),
    }));
    child.once("close", (exitCode) => {
      const durationMs = Math.round(performance.now() - started);
      finish({
        status: exitCode === 0 ? "success" : "error",
        message: exitCode === 0 ? `Passed in ${(durationMs / 1000).toFixed(1)}s` : `Failed with exit code ${exitCode ?? "unknown"}.`,
        durationMs,
        exitCode,
        output: outputExcerpt(output),
      });
    });
  });
}

export async function runProjectCheck(repository: Repository, check: "test" | "lint" | "build" | "verify") {
  if (check === "verify") {
    if (!repository.capabilities.hasMavenWrapper) return { status: "error", message: "No Maven wrapper was detected." } satisfies RepositoryActionResult;
    return executeAllowlisted(repository, process.platform === "win32" ? ".\\mvnw.cmd" : "./mvnw", ["verify"]);
  }

  if (repository.capabilities.packageScripts.includes(check)) {
    const packageManager = repository.capabilities.packageManager;
    if (!packageManager) return { status: "error", message: "No supported package manager was detected." } satisfies RepositoryActionResult;
    const command = packageCheckCommand(packageManager, check);
    return executeAllowlisted(repository, command.executable, command.args);
  }

  if (check === "test" && repository.capabilities.hasMavenWrapper) {
    return executeAllowlisted(repository, process.platform === "win32" ? ".\\mvnw.cmd" : "./mvnw", ["test"]);
  }

  return { status: "error", message: `This repository does not expose an allowlisted ${check} action.` } satisfies RepositoryActionResult;
}
