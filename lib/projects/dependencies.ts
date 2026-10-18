import "server-only";

import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import type { DependencyRuntimeStatus, RepositoryActionResult } from "./action-types";
import { dependencyControlPolicy } from "./dependency-policy";
import { buildComposeCommandArgs, classifyComposePsIdentity, composeRowsUseConfigFile, devHubComposeProjectName, devHubDependencyComposeProjectId, redactRuntimeOutput, summarizeRuntimeOutput } from "./runtime-config";
import { resolveSpringRuntime, type ResolvedComposeDependencies, type ResolvedSpringRuntime } from "./runtime-profile";
import type { ProjectService, Repository } from "@/lib/workspace/types";

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

function dependencyKey(repository: Repository, service: ProjectService) {
  return `${repository.id}:${service.id}`;
}

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

type DependencyIdentityInspection = {
  available: boolean;
  output: string;
  error: string | null;
};

async function inspectComposeIdentity(repository: Repository, service: ProjectService, runtime: ResolvedSpringRuntime): Promise<DependencyIdentityInspection> {
  const profile = runtime.dependencies;
  if (!profile) return { available: false, output: "", error: "No Compose dependency configuration was detected." };
  try {
    const executable = await dockerExecutable();
    await verifyDockerDaemon(executable);
    const projectId = devHubDependencyComposeProjectId(repository.id, service.id, profile.infrastructureId);
    const args = buildComposeCommandArgs(projectId, profile.composePath, "status", profile.services.map((service) => service.service));
    const { stdout } = await execFileAsync(executable, args, {
      cwd: profile.composeDirectory,
      env: runtime.environment,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { available: true, output: stdout, error: null };
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string };
    const safe = summarizeRuntimeOutput(`${details.stderr ?? ""}\n${details.stdout ?? ""}`, runtime.redactions);
    return { available: false, output: "", error: safe || (error instanceof Error ? error.message : "Docker Compose identity could not be verified.") };
  }
}

async function statusFromProfile(
  key: string,
  repository: Repository,
  service: ProjectService,
  runtime: ResolvedSpringRuntime,
): Promise<DependencyRuntimeStatus> {
  const profile = runtime.dependencies;
  const managed = dependencyStore.managed.get(key);
  if (!profile) {
    return { composeFile: null, composeProject: null, services: [], ownedByDevHub: false, canStart: false, canStop: false, message: null };
  }

  const projectId = devHubDependencyComposeProjectId(repository.id, service.id, profile.infrastructureId);
  const projectName = devHubComposeProjectName(projectId);
  const inspection = await inspectComposeIdentity(repository, service, runtime);
  const services = await Promise.all(profile.services.map(async (service) => {
    const reachable = service.hostPort ? await portReachable(service.hostPort) : false;
    if (!inspection.available) return {
      displayName: service.displayName,
      service: service.service,
      endpoint: service.hostPort ? `localhost:${service.hostPort}` : null,
      state: reachable ? "unverified" as const : "unknown" as const,
      diagnostic: inspection.error ?? "Docker Compose identity could not be verified.",
    };
    const identity = service.hostPort === null
      ? { state: "mismatch" as const, reason: "missing-publisher" as const }
      : classifyComposePsIdentity(inspection.output, projectName, [service.service], "127.0.0.1", service.hostPort);
    if (identity.state === "stopped") return {
      displayName: service.displayName,
      service: service.service,
      endpoint: service.hostPort ? `localhost:${service.hostPort}` : null,
      state: reachable || identity.rows.length > 0 && !composeRowsUseConfigFile(identity.rows, profile.composePath) ? "unverified" as const : "stopped" as const,
      diagnostic: reachable
        ? `The port is reachable, but it is not published by ${projectName}/${service.service}.`
        : identity.rows.length > 0 && !composeRowsUseConfigFile(identity.rows, profile.composePath)
          ? "A stopped container uses the expected project and service names, but its trusted Compose file identity does not match."
          : identity.rows.length > 0
            ? `Verified stopped ${projectName}/${service.service}; Start will reuse its Compose resources.`
            : `No ${projectName}/${service.service} Compose service was found.`,
    };
    if (identity.state === "mismatch") return {
      displayName: service.displayName,
      service: service.service,
      endpoint: service.hostPort ? `localhost:${service.hostPort}` : null,
      state: "unverified" as const,
      diagnostic: `The running dependency does not match the expected ${projectName}/${service.service} project, service, and loopback publisher.`,
    };
    if (!reachable || identity.state === "degraded") return {
      displayName: service.displayName,
      service: service.service,
      endpoint: service.hostPort ? `localhost:${service.hostPort}` : null,
      state: managed?.services.includes(service.service) ? "failed" as const : "unverified" as const,
      diagnostic: !reachable ? "The verified Compose service is not reachable on its configured host port." : "The verified Compose service is not healthy.",
    };
    if (!composeRowsUseConfigFile(identity.rows, profile.composePath)) return {
      displayName: service.displayName,
      service: service.service,
      endpoint: service.hostPort ? `localhost:${service.hostPort}` : null,
      state: "unverified" as const,
      diagnostic: "The Compose project and publisher match, but the trusted Compose configuration file identity does not.",
    };
    return {
      displayName: service.displayName,
      service: service.service,
      endpoint: service.hostPort ? `localhost:${service.hostPort}` : null,
      state: "ready" as const,
      diagnostic: `Verified ${projectName}/${service.service} with the configured loopback publisher.`,
    };
  }));
  const sameManagedProfile = Boolean(managed
    && managed.composePath === profile.composePath
    && managed.services.length === profile.services.length
    && managed.services.every((service: string) => profile.services.some((candidate) => candidate.service === service)));
  const allReady = services.every((service) => service.state === "ready");
  const canManage = manageable(profile);
  const controls = dependencyControlPolicy({
    manageable: canManage,
    identityAvailable: inspection.available,
    sameManagedProfile,
    states: services.map((service) => service.state),
  });

  return {
    composeFile: profile.composeFile,
    composeProject: projectName,
    services,
    ...controls,
    message: managed?.lastFailure
      ?? (!canManage
        ? "Dependency metadata is incomplete, so DevHub will not manage these services."
        : services.some((service) => service.state === "unverified")
          ? "A dependency endpoint is occupied, but the expected legacy Compose identity could not be verified. Start and Stop are disabled."
          : !inspection.available
            ? inspection.error
            : allReady && !sameManagedProfile
              ? "The expected legacy Compose dependency is running, but it was not started by this DevHub session; Stop is unavailable."
              : null),
  };
}

export async function getDependencyStatus(repository: Repository, service: ProjectService) {
  const key = dependencyKey(repository, service);
  if (!service.capabilities.hasSpringBoot) return { composeFile: null, composeProject: null, services: [], ownedByDevHub: false, canStart: false, canStop: false, message: null };
  const runtime = await resolveSpringRuntime(repository, service);
  return statusFromProfile(key, repository, service, runtime);
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
  service: ProjectService,
  runtime: Awaited<ReturnType<typeof resolveSpringRuntime>>,
  operation: "start" | "stop",
  services: string[],
) {
  const projectId = devHubDependencyComposeProjectId(repository.id, service.id, runtime.dependencies!.infrastructureId);
  const args = buildComposeCommandArgs(projectId, runtime.dependencies!.composePath, operation, services);
  try {
    const result = await execFileAsync(executable, args, {
      cwd: runtime.dependencies!.composeDirectory,
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

async function startDependenciesOnce(repository: Repository, service: ProjectService): Promise<RepositoryActionResult> {
  const key = dependencyKey(repository, service);
  const runtime = await resolveSpringRuntime(repository, service);
  const profile = runtime.dependencies;
  if (!profile || !manageable(profile)) {
    const dependencies = await statusFromProfile(key, repository, service, runtime);
    return { status: "error", message: dependencies.message ?? "No confidently identified local dependencies can be started.", dependencies, springRuntime: runtime.status };
  }
  const existing = await statusFromProfile(key, repository, service, runtime);
  if (existing.services.every((service) => service.state === "ready")) {
    return { status: "success", message: "Dependencies are already reachable.", dependencies: existing, springRuntime: runtime.status };
  }
  if (!existing.canStart) {
    return { status: "error", message: existing.message ?? "The expected dependency identity could not be started safely.", dependencies: existing, springRuntime: runtime.status };
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
  dependencyStore.managed.set(key, { composePath: profile.composePath, services: serviceNames, lastFailure: null });
  try {
    output = await runCompose(executable, repository, service, runtime, "start", serviceNames);
  } catch (error) {
    const safeOutput = (error as Error & { safeOutput?: string }).safeOutput;
    const managed = dependencyStore.managed.get(key);
    if (managed) managed.lastFailure = "Docker Compose could not start the identified dependencies.";
    return { status: "error", message: "Docker Compose could not start the identified dependencies.", output: safeOutput, dependencies: await statusFromProfile(key, repository, service, runtime), springRuntime: runtime.status };
  }

  if (!await waitForPorts(profile, true, START_WAIT_MS)) {
    const managed = dependencyStore.managed.get(key);
    if (managed) managed.lastFailure = "Dependencies started, but their published ports did not become reachable.";
    const refreshed = await resolveSpringRuntime(repository, service);
    return { status: "error", message: managed?.lastFailure ?? "Dependencies did not become ready.", output, dependencies: await statusFromProfile(key, repository, service, refreshed), springRuntime: refreshed.status };
  }

  const refreshedRuntime = await resolveSpringRuntime(repository, service);
  return {
    status: "success",
    message: "Local dependencies are ready.",
    output,
    dependencies: await statusFromProfile(key, repository, service, refreshedRuntime),
    springRuntime: refreshedRuntime.status,
  };
}

export function startDependencies(repository: Repository, service: ProjectService) {
  const key = dependencyKey(repository, service);
  const inFlight = dependencyStore.operations.get(key);
  if (inFlight) return inFlight;
  const operation = startDependenciesOnce(repository, service).finally(() => {
    if (dependencyStore.operations.get(key) === operation) dependencyStore.operations.delete(key);
  });
  dependencyStore.operations.set(key, operation);
  return operation;
}

async function stopDependenciesOnce(repository: Repository, service: ProjectService): Promise<RepositoryActionResult> {
  const key = dependencyKey(repository, service);
  const managed = dependencyStore.managed.get(key);
  if (!managed) return { status: "error", message: "No DevHub-started dependencies are tracked for this service.", dependencies: await getDependencyStatus(repository, service) };

  const runtime = await resolveSpringRuntime(repository, service);
  const profile = runtime.dependencies;
  const servicesStillTrusted = Boolean(profile
    && profile.composePath === managed.composePath
    && managed.services.length === profile.services.length
    && managed.services.every((service: string) => profile.services.some((candidate) => candidate.service === service)));
  if (!profile || !servicesStillTrusted) {
    return { status: "error", message: "Dependency configuration changed, so DevHub will not stop the previously tracked services.", dependencies: await statusFromProfile(key, repository, service, runtime), springRuntime: runtime.status };
  }

  let executable: string;
  try {
    executable = await dockerExecutable();
    await verifyDockerDaemon(executable);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Docker is unavailable.", dependencies: await statusFromProfile(key, repository, service, runtime), springRuntime: runtime.status };
  }

  let output = "";
  try {
    output = await runCompose(executable, repository, service, runtime, "stop", managed.services);
  } catch (error) {
    const safeOutput = (error as Error & { safeOutput?: string }).safeOutput;
    return { status: "error", message: "Docker Compose could not stop the DevHub-started dependencies.", output: safeOutput, dependencies: await statusFromProfile(key, repository, service, runtime), springRuntime: runtime.status };
  }

  if (!await waitForPorts(profile, false, STOP_WAIT_MS)) {
    managed.lastFailure = "Docker Compose returned, but a dependency port is still reachable.";
    return { status: "error", message: managed.lastFailure, output, dependencies: await statusFromProfile(key, repository, service, runtime), springRuntime: runtime.status };
  }

  dependencyStore.managed.delete(key);
  const refreshedRuntime = await resolveSpringRuntime(repository, service);
  return {
    status: "stopped",
    message: "DevHub stopped its local dependencies. Containers and volumes were preserved.",
    output,
    dependencies: await statusFromProfile(key, repository, service, refreshedRuntime),
    springRuntime: refreshedRuntime.status,
  };
}

export function stopDependencies(repository: Repository, service: ProjectService) {
  const key = dependencyKey(repository, service);
  const inFlight = dependencyStore.operations.get(key);
  if (inFlight) return inFlight;
  const operation = stopDependenciesOnce(repository, service).finally(() => {
    if (dependencyStore.operations.get(key) === operation) dependencyStore.operations.delete(key);
  });
  dependencyStore.operations.set(key, operation);
  return operation;
}
