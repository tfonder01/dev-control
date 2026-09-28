import "server-only";

import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import type { DependencyRuntimeStatus, RepositoryActionResult } from "./action-types";
import { buildComposeCommandArgs, redactRuntimeOutput } from "./runtime-config";
import { resolveSpringRuntime, type ResolvedComposeDependencies } from "./runtime-profile";
import type { Repository } from "@/lib/workspace/types";

const execFileAsync = promisify(execFile);
const START_WAIT_MS = 45_000;
const STOP_WAIT_MS = 20_000;
const MAX_OUTPUT_CHARS = 12_000;

type ManagedDependencies = {
  composePath: string;
  services: string[];
  lastFailure: string | null;
};

type DependencyStore = {
  managed: Map<string, ManagedDependencies>;
  operations: Map<string, Promise<RepositoryActionResult>>;
};

const dependencyGlobal = globalThis as typeof globalThis & { __devHubDependencies?: DependencyStore };
const dependencyStore = dependencyGlobal.__devHubDependencies ??= {
  managed: new Map(),
  operations: new Map(),
};

function portReachable(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function manageable(profile: ResolvedComposeDependencies) {
  return profile.services.length > 0 && profile.services.every((service) => service.hostPort !== null && service.containerPort !== null);
}

async function statusFromProfile(repositoryId: string, profile: ResolvedComposeDependencies | null): Promise<DependencyRuntimeStatus> {
  const managed = dependencyStore.managed.get(repositoryId);
  if (!profile) {
    return { composeFile: null, services: [], ownedByDevHub: false, canStart: false, canStop: false, message: null };
  }

  const services = await Promise.all(profile.services.map(async (service) => {
    const ready = service.hostPort ? await portReachable(service.hostPort) : false;
    const failed = Boolean(managed?.lastFailure && managed.services.includes(service.service) && !ready);
    return {
      displayName: service.displayName,
      service: service.service,
      endpoint: service.hostPort ? `localhost:${service.hostPort}` : null,
      state: ready ? "ready" as const : failed ? "failed" as const : service.hostPort ? "stopped" as const : "unknown" as const,
    };
  }));
  const sameManagedProfile = Boolean(managed
    && managed.composePath === profile.composePath
    && managed.services.length === profile.services.length
    && managed.services.every((service: string) => profile.services.some((candidate) => candidate.service === service)));
  const allReady = services.every((service) => service.state === "ready");
  const canManage = manageable(profile);

  return {
    composeFile: profile.composeFile,
    services,
    ownedByDevHub: sameManagedProfile,
    canStart: canManage && !allReady && !sameManagedProfile,
    canStop: canManage && sameManagedProfile,
    message: managed?.lastFailure ?? (!canManage ? "Dependency metadata is incomplete, so DevHub will not manage these services." : null),
  };
}

export async function getDependencyStatus(repository: Repository) {
  if (!repository.capabilities.hasSpringBoot) return statusFromProfile(repository.id, null);
  const runtime = await resolveSpringRuntime(repository);
  return statusFromProfile(repository.id, runtime.dependencies);
}

async function dockerExecutable() {
  if (process.platform !== "win32") return "docker";
  try {
    const { stdout } = await execFileAsync("where.exe", ["docker.exe"], { windowsHide: true, timeout: 3_000 });
    const executable = stdout.trim().split(/\r?\n/)[0];
    if (executable) return executable;
  } catch {
    // A concise, stable message is returned below.
  }
  throw new Error("Docker CLI is not installed or is not available on PATH.");
}

async function verifyDockerDaemon(executable: string) {
  try {
    await execFileAsync(executable, ["version", "--format", "{{.Server.Version}}"], {
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("Docker is installed, but the Docker daemon is not reachable.");
  }
}

async function runCompose(
  executable: string,
  repository: Repository,
  runtime: Awaited<ReturnType<typeof resolveSpringRuntime>>,
  operation: "start" | "stop",
  services: string[],
) {
  const args = buildComposeCommandArgs(repository.id, runtime.dependencies!.composePath, operation, services);
  try {
    const result = await execFileAsync(executable, args, {
      cwd: repository.path,
      env: runtime.environment,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return redactRuntimeOutput(`${result.stdout}${result.stderr}`.trim(), runtime.redactions).slice(-MAX_OUTPUT_CHARS);
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string };
    const output = redactRuntimeOutput(`${details.stdout ?? ""}${details.stderr ?? ""}`.trim(), runtime.redactions).slice(-MAX_OUTPUT_CHARS);
    throw Object.assign(new Error(details.message), { safeOutput: output });
  }
}

async function waitForPorts(profile: ResolvedComposeDependencies, expectedOpen: boolean, timeoutMs: number) {
  const ports = profile.services.map((service) => service.hostPort).filter((port): port is number => port !== null);
  const deadline = Date.now() + timeoutMs;
  do {
    const results = await Promise.all(ports.map(portReachable));
    if (results.every((result) => result === expectedOpen)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return false;
}

async function startDependenciesOnce(repository: Repository): Promise<RepositoryActionResult> {
  const runtime = await resolveSpringRuntime(repository);
  const profile = runtime.dependencies;
  if (!profile || !manageable(profile)) {
    const dependencies = await statusFromProfile(repository.id, profile);
    return { status: "error", message: dependencies.message ?? "No confidently identified local dependencies can be started.", dependencies, springRuntime: runtime.status };
  }
  const existing = await statusFromProfile(repository.id, profile);
  if (existing.services.every((service) => service.state === "ready")) {
    return { status: "success", message: "Dependencies are already reachable.", dependencies: existing, springRuntime: runtime.status };
  }

  let executable: string;
  try {
    executable = await dockerExecutable();
    await verifyDockerDaemon(executable);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Docker is unavailable.", dependencies: existing, springRuntime: runtime.status };
  }

  const serviceNames = profile.services.map((service) => service.service);
  let output = "";
  dependencyStore.managed.set(repository.id, { composePath: profile.composePath, services: serviceNames, lastFailure: null });
  try {
    output = await runCompose(executable, repository, runtime, "start", serviceNames);
  } catch (error) {
    const safeOutput = (error as Error & { safeOutput?: string }).safeOutput;
    const managed = dependencyStore.managed.get(repository.id);
    if (managed) managed.lastFailure = "Docker Compose could not start the identified dependencies.";
    return { status: "error", message: "Docker Compose could not start the identified dependencies.", output: safeOutput, dependencies: await statusFromProfile(repository.id, profile), springRuntime: runtime.status };
  }

  if (!await waitForPorts(profile, true, START_WAIT_MS)) {
    const managed = dependencyStore.managed.get(repository.id);
    if (managed) managed.lastFailure = "Dependencies started, but their published ports did not become reachable.";
    return { status: "error", message: managed?.lastFailure ?? "Dependencies did not become ready.", output, dependencies: await statusFromProfile(repository.id, profile), springRuntime: (await resolveSpringRuntime(repository)).status };
  }

  const refreshedRuntime = await resolveSpringRuntime(repository);
  return {
    status: "success",
    message: "Local dependencies are ready.",
    output,
    dependencies: await statusFromProfile(repository.id, refreshedRuntime.dependencies),
    springRuntime: refreshedRuntime.status,
  };
}

export function startDependencies(repository: Repository) {
  const inFlight = dependencyStore.operations.get(repository.id);
  if (inFlight) return inFlight;
  const operation = startDependenciesOnce(repository).finally(() => {
    if (dependencyStore.operations.get(repository.id) === operation) dependencyStore.operations.delete(repository.id);
  });
  dependencyStore.operations.set(repository.id, operation);
  return operation;
}

async function stopDependenciesOnce(repository: Repository): Promise<RepositoryActionResult> {
  const managed = dependencyStore.managed.get(repository.id);
  if (!managed) return { status: "error", message: "No DevHub-started dependencies are tracked for this repository.", dependencies: await getDependencyStatus(repository) };

  const runtime = await resolveSpringRuntime(repository);
  const profile = runtime.dependencies;
  const servicesStillTrusted = Boolean(profile
    && profile.composePath === managed.composePath
    && managed.services.length === profile.services.length
    && managed.services.every((service: string) => profile.services.some((candidate) => candidate.service === service)));
  if (!profile || !servicesStillTrusted) {
    return { status: "error", message: "Dependency configuration changed, so DevHub will not stop the previously tracked services.", dependencies: await statusFromProfile(repository.id, profile), springRuntime: runtime.status };
  }

  let executable: string;
  try {
    executable = await dockerExecutable();
    await verifyDockerDaemon(executable);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Docker is unavailable.", dependencies: await statusFromProfile(repository.id, profile), springRuntime: runtime.status };
  }

  let output = "";
  try {
    output = await runCompose(executable, repository, runtime, "stop", managed.services);
  } catch (error) {
    const safeOutput = (error as Error & { safeOutput?: string }).safeOutput;
    return { status: "error", message: "Docker Compose could not stop the DevHub-started dependencies.", output: safeOutput, dependencies: await statusFromProfile(repository.id, profile), springRuntime: runtime.status };
  }

  if (!await waitForPorts(profile, false, STOP_WAIT_MS)) {
    managed.lastFailure = "Docker Compose returned, but a dependency port is still reachable.";
    return { status: "error", message: managed.lastFailure, output, dependencies: await statusFromProfile(repository.id, profile), springRuntime: runtime.status };
  }

  dependencyStore.managed.delete(repository.id);
  const refreshedRuntime = await resolveSpringRuntime(repository);
  return {
    status: "stopped",
    message: "DevHub stopped its local dependencies. Containers and volumes were preserved.",
    output,
    dependencies: await statusFromProfile(repository.id, refreshedRuntime.dependencies),
    springRuntime: refreshedRuntime.status,
  };
}

export function stopDependencies(repository: Repository) {
  const inFlight = dependencyStore.operations.get(repository.id);
  if (inFlight) return inFlight;
  const operation = stopDependenciesOnce(repository).finally(() => {
    if (dependencyStore.operations.get(repository.id) === operation) dependencyStore.operations.delete(repository.id);
  });
  dependencyStore.operations.set(repository.id, operation);
  return operation;
}
