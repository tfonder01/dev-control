import "server-only";

import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { TrustedProcessEnvironmentService } from "./environment-config";
import type { TrustedProcessController } from "./environment-adapters";
import type { EnvironmentAdapterContext, EnvironmentPreflightIssue } from "./environment-orchestrator";
import { createBoundedRuntimeEnvironment } from "./runtime-environment";
import { managedProcessObservation } from "./process-status";
import {
  detectTrustedManagedProcess,
  startTrustedManagedProcess,
  stopTrustedManagedProcess,
  type TrustedManagedCommand,
} from "./processes";

const execFileAsync = promisify(execFile);

function inside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveWorkingDirectory(context: EnvironmentAdapterContext, service: TrustedProcessEnvironmentService) {
  const workingDirectory = service.workingDirectory;
  if ("externalPathVariable" in workingDirectory) {
    const configured = process.env[workingDirectory.externalPathVariable]?.trim();
    if (!configured || !path.isAbsolute(configured)) throw new Error("The owner-controlled process working directory is unavailable.");
    const resolved = await realpath(configured);
    if (!(await stat(resolved)).isDirectory()) throw new Error("The owner-controlled process working directory is unavailable.");
    return resolved;
  }
  const reference = context.config.repositories.find((candidate) => candidate.id === workingDirectory.repository);
  const repository = context.repositories.find((candidate) => candidate.id === reference?.repositoryId);
  if (!repository) throw new Error("The configured process repository is unavailable.");
  const [root, candidate] = await Promise.all([
    realpath(repository.path),
    realpath(path.resolve(repository.path, workingDirectory.path)),
  ]);
  if (!inside(root, candidate) || !(await stat(candidate)).isDirectory()) throw new Error("The configured process working directory is outside its trusted repository.");
  return candidate;
}

async function resolveExecutable(executable: string) {
  if (path.isAbsolute(executable)) {
    await access(executable);
    if (!(await stat(executable)).isFile()) throw new Error("The configured executable is unavailable.");
    return executable;
  }
  if (path.basename(executable) !== executable || !/^[A-Za-z0-9_.-]+$/.test(executable)) {
    throw new Error("The configured executable must be an absolute path or a command name resolved from PATH.");
  }
  if (process.platform !== "win32") return executable;
  const { stdout } = await execFileAsync("where.exe", [executable], { windowsHide: true, timeout: 3_000 });
  const resolved = stdout.trim().split(/\r?\n/)[0];
  if (!resolved) throw new Error("The configured executable is unavailable.");
  return resolved;
}

async function command(context: EnvironmentAdapterContext, service: TrustedProcessEnvironmentService): Promise<TrustedManagedCommand> {
  if (!service.port) throw new Error("A fixed process port is required.");
  const [cwd, executable, stopExecutable] = await Promise.all([
    resolveWorkingDirectory(context, service),
    resolveExecutable(service.executable),
    service.stop ? resolveExecutable(service.stop.executable) : Promise.resolve(null),
  ]);
  const argumentRedactions = [...service.args, ...(service.stop?.args ?? [])].filter((value) => value.length >= 4);
  return {
    runtimeKey: `${context.runtimeScope}:process:${service.id}`,
    serviceId: service.id,
    servicePath: cwd,
    executable,
    args: service.args,
    cwd,
    environment: createBoundedRuntimeEnvironment(process.env, context.environment),
    redactions: [...new Set([...context.redactions, ...argumentRedactions])],
    port: service.port,
    host: service.host ?? "127.0.0.1",
    gracefulStop: service.stop && stopExecutable ? { executable: stopExecutable, args: service.stop.args } : null,
  };
}

export function createTrustedProcessController(): TrustedProcessController {
  return {
    async preflight(context, service) {
      const issues: EnvironmentPreflightIssue[] = [];
      try {
        await command(context, service);
      } catch (error) {
        issues.push({ serviceId: service.id, code: "trust", message: error instanceof Error ? error.message : "Trusted process configuration is unavailable." });
      }
      return issues;
    },
    async inspect(context, service) {
      try {
        return managedProcessObservation(await detectTrustedManagedProcess(await command(context, service)));
      } catch (error) {
        return { state: "degraded", ownership: "unverified", message: error instanceof Error ? error.message : "Trusted process configuration is unavailable.", port: service.port, url: null };
      }
    },
    async start(context, service) {
      const result = await startTrustedManagedProcess(await command(context, service));
      if (result.status === "error") throw new Error(result.message);
      if (!result.devServer) throw new Error(result.message);
      return managedProcessObservation(result.devServer);
    },
    async stop(context, service) {
      const result = await stopTrustedManagedProcess(await command(context, service));
      if (!result.devServer) throw new Error(result.message);
      return managedProcessObservation(result.devServer);
    },
  };
}
