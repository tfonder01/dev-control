import "server-only";

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DockerComposeEnvironmentService,
  NodeEnvironmentService,
  SpringBootEnvironmentService,
  TrustedProcessEnvironmentService,
} from "./environment-config";
import type {
  EnvironmentAdapterContext,
  EnvironmentAdapterRegistry,
  EnvironmentPreflightIssue,
  EnvironmentRuntimeAdapter,
  EnvironmentServiceObservation,
} from "./environment-orchestrator";
import { createBoundedRuntimeEnvironment } from "./runtime-environment";
import { buildComposeContainerStateArgs, buildExplicitComposeCommandArgs, classifyComposeContainerState, classifyComposePsIdentity, composeRowsUseConfigFile, parseComposePsRecords, summarizeRuntimeOutput } from "./runtime-config";
import { detectRunningDevServer, startDevServer, startPreviewServer, stopDevServer } from "./processes";
import { resolveProjectService } from "./service-resolution";
import type { Repository } from "@/lib/workspace/types";

const execFileAsync = promisify(execFile);

function repositoryFor(context: EnvironmentAdapterContext, reference: string) {
  const repositoryId = context.config.repositories.find((candidate) => candidate.id === reference)?.repositoryId;
  return context.repositories.find((candidate) => candidate.id === repositoryId) ?? null;
}

function serviceFor(context: EnvironmentAdapterContext, service: NodeEnvironmentService | SpringBootEnvironmentService) {
  const repository = repositoryFor(context, service.repository);
  return { repository, service: repository ? resolveProjectService(repository, service.serviceId) : null };
}

function mapStatus(status: Awaited<ReturnType<typeof detectRunningDevServer>>): EnvironmentServiceObservation {
  const state = status.state === "stopped" ? "stopped"
    : status.state === "starting" ? "starting"
      : status.state === "running" || status.state === "external" ? "started"
        : "degraded";
  return {
    state,
    ownership: status.ownedByDevHub ? "devhub" : status.state === "external" ? "external" : status.state === "stopped" ? "none" : "unverified",
    message: status.message,
    recentLogs: status.ownedByDevHub ? status.output ?? null : null,
    exitClassification: status.exitClassification,
    exitCode: status.exitCode,
    launchMode: status.launchMode,
    port: status.port,
    url: status.url,
  };
}

function applicationAdapter(expected: "node" | "spring-boot"): EnvironmentRuntimeAdapter {
  return {
    async preflight(context) {
      if (context.service.adapter !== expected) return [{ serviceId: context.service.id, code: "adapter", message: "Adapter configuration does not match the service." }];
      const resolved = serviceFor(context, context.service);
      const issues: EnvironmentPreflightIssue[] = [];
      if (!resolved.repository) issues.push({ serviceId: context.service.id, code: "repository", message: `Repository ${context.service.repository} is unavailable.` });
      else if (!resolved.service || resolved.service.kind !== expected) issues.push({ serviceId: context.service.id, code: "service", message: `${context.service.name} does not resolve to the expected runtime.` });
      else if (expected === "node" && context.profile.loopbackOnly && !resolved.service.technologies.some((technology) => technology.name === "Next.js")) {
        issues.push({ serviceId: context.service.id, code: "trust", message: `${context.service.name} cannot prove loopback binding with the detected Node adapter.` });
      }
      return issues;
    },
    async inspect(context) {
      const configured = context.service as NodeEnvironmentService | SpringBootEnvironmentService;
      const resolved = serviceFor(context, configured);
      if (!resolved.repository || !resolved.service) return { state: "degraded", ownership: "unverified", message: "Configured runtime is unavailable.", port: configured.port, url: null };
      return mapStatus(await detectRunningDevServer(resolved.repository, resolved.service, {
        runtimeScope: context.runtimeScope,
        fixedPort: configured.port ?? undefined,
        host: configured.host ?? "127.0.0.1",
      }));
    },
    async start(context) {
      const configured = context.service as NodeEnvironmentService | SpringBootEnvironmentService;
      const resolved = serviceFor(context, configured);
      if (!resolved.repository || !resolved.service) throw new Error("Configured runtime is unavailable.");
      const options = {
        runtimeScope: context.runtimeScope,
        fixedPort: configured.port ?? undefined,
        host: configured.host ?? "127.0.0.1",
        environment: context.environment,
        redactions: context.redactions,
        springProfile: configured.adapter === "spring-boot" ? configured.springProfile : undefined,
      };
      const result = configured.adapter === "node" && configured.launchMode === "preview"
        ? await startPreviewServer(resolved.repository, resolved.service, options)
        : await startDevServer(resolved.repository, resolved.service, options);
      if (!result.devServer) throw new Error(result.message);
      return mapStatus(result.devServer);
    },
    async stop(context) {
      const configured = context.service as NodeEnvironmentService | SpringBootEnvironmentService;
      const resolved = serviceFor(context, configured);
      if (!resolved.repository || !resolved.service) throw new Error("Configured runtime is unavailable.");
      const result = await stopDevServer(resolved.repository, resolved.service, {
        runtimeScope: context.runtimeScope,
        fixedPort: configured.port ?? undefined,
        host: configured.host ?? "127.0.0.1",
      });
      if (!result.devServer) throw new Error(result.message);
      return mapStatus(result.devServer);
    },
  };
}

type ManagedCompose = { composePath: string; projectName: string; services: string[] };
const composeGlobal = globalThis as typeof globalThis & { __devHubEnvironmentCompose?: Map<string, ManagedCompose> };
const managedCompose = composeGlobal.__devHubEnvironmentCompose ??= new Map();

async function dockerExecutable() {
  if (process.platform !== "win32") return "docker";
  const { stdout } = await execFileAsync("where.exe", ["docker.exe"], { windowsHide: true, timeout: 3_000 });
  const executable = stdout.trim().split(/\r?\n/)[0];
  if (!executable) throw new Error("Docker CLI is unavailable.");
  return executable;
}

async function composeMetadata(context: EnvironmentAdapterContext, service: DockerComposeEnvironmentService) {
  const repository = repositoryFor(context, service.repository);
  if (!repository) throw new Error("Configured Compose repository is unavailable.");
  const [root, composePath] = await Promise.all([
    realpath(repository.path),
    realpath(path.resolve(repository.path, service.composeFile)),
  ]);
  const relative = path.relative(root, composePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(composePath)).isFile()) {
    throw new Error("Configured Compose file is outside its trusted repository.");
  }
  return { repository, composePath };
}

function composeKey(context: EnvironmentAdapterContext) {
  return `${context.runtimeScope}:${context.service.id}`;
}

function composeAdapter(): EnvironmentRuntimeAdapter {
  function environmentFiles(context: EnvironmentAdapterContext) {
    return context.sources.flatMap((source) => source.available && source.resolvedPath ? [source.resolvedPath] : []);
  }

  function mismatchMessage(reason: ReturnType<typeof classifyComposePsIdentity>["reason"], host: string, port: number) {
    const endpoint = `${host}:${port}`;
    if (reason === "missing-service") return "The configured Compose project does not contain every required service.";
    if (reason === "project") return "The running Compose service belongs to a different project.";
    if (reason === "non-loopback-publisher") return `The Compose service publishes outside loopback; expected only ${endpoint}.`;
    if (reason === "missing-publisher") return `The Compose service is running but does not actively publish the required loopback endpoint ${endpoint}.`;
    return "Compose project, service, or loopback publishing identity does not match the configured profile.";
  }

  function commandFailureDetail(error: unknown, redactions: string[]) {
    const details = error as Error & { stdout?: string; stderr?: string };
    return summarizeRuntimeOutput(`${details.stderr ?? ""}\n${details.stdout ?? ""}`, redactions);
  }

  async function inspect(context: EnvironmentAdapterContext): Promise<EnvironmentServiceObservation> {
    const service = context.service as DockerComposeEnvironmentService;
    let composePath: string;
    let executable: string;
    try {
      ({ composePath } = await composeMetadata(context, service));
      executable = await dockerExecutable();
    } catch (error) {
      return { state: "degraded", ownership: "unverified", message: error instanceof Error ? error.message : "Compose runtime is unavailable.", port: service.port, url: null };
    }
    try {
      const args = buildExplicitComposeCommandArgs(service.projectName, composePath, "status", service.services, environmentFiles(context));
      const { stdout } = await execFileAsync(executable, args, { cwd: path.dirname(composePath), windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
      const identity = classifyComposePsIdentity(stdout, service.projectName, service.services, service.host ?? "127.0.0.1", service.port!);
      if (identity.rows.length > 0 && !composeRowsUseConfigFile(identity.rows, composePath)) return {
        state: "degraded",
        ownership: "unverified",
        message: "The Compose project was created from a different configuration file.",
        port: service.port,
        url: null,
      };
      if (identity.state === "stopped") return { state: "stopped", ownership: "none", message: "Stopped", port: service.port, url: null };
      if (identity.state === "mismatch") return {
        state: "degraded",
        ownership: "unverified",
        message: mismatchMessage(identity.reason, service.host ?? "127.0.0.1", service.port!),
        port: service.port,
        url: null,
      };
      const healthy = identity.state === "healthy";
      const managed = managedCompose.get(composeKey(context));
      const owned = Boolean(managed && managed.composePath === composePath && managed.projectName === service.projectName && managed.services.join("\0") === service.services.join("\0"));
      return {
        state: healthy ? "healthy" : "started",
        ownership: owned ? "devhub" : "external",
        message: healthy ? "Configured Compose services are healthy." : "Configured Compose services are running but not healthy.",
        port: service.port,
        url: null,
      };
    } catch (error) {
      const detail = commandFailureDetail(error, context.redactions);
      try {
        const { stdout } = await execFileAsync(executable, buildComposeContainerStateArgs(service.projectName), {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        const fallback = classifyComposeContainerState(stdout, service.projectName, service.services);
        if (fallback.state === "stopped") return {
          state: "stopped",
          ownership: "none",
          message: "Stopped (confirmed from Docker container state).",
          port: service.port,
          url: null,
        };
      } catch {
        // Preserve the original Compose diagnostic when Docker metadata is also unavailable.
      }
      return { state: "degraded", ownership: "unverified", message: detail
        ? `Docker Compose status could not be verified: ${detail}`
        : "Docker Compose status could not be verified.", port: service.port, url: null };
    }
  }

  return {
    async preflight(context) {
      const service = context.service as DockerComposeEnvironmentService;
      try {
        await composeMetadata(context, service);
        const executable = await dockerExecutable();
        await execFileAsync(executable, ["version", "--format", "{{.Server.Version}}"], { windowsHide: true, timeout: 8_000 });
        return [];
      } catch (error) {
        return [{ serviceId: service.id, code: "adapter", message: error instanceof Error ? error.message : "Docker is unavailable." }];
      }
    },
    inspect,
    async start(context) {
      const service = context.service as DockerComposeEnvironmentService;
      const { composePath } = await composeMetadata(context, service);
      const executable = await dockerExecutable();
      const identity = { composePath, projectName: service.projectName, services: [...service.services] };
      const key = composeKey(context);
      managedCompose.set(key, identity);
      try {
        await execFileAsync(executable, buildExplicitComposeCommandArgs(service.projectName, composePath, "start", service.services, environmentFiles(context)), {
          cwd: path.dirname(composePath),
          env: createBoundedRuntimeEnvironment(process.env, context.environment),
          windowsHide: true,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        try {
          await execFileAsync(executable, buildExplicitComposeCommandArgs(service.projectName, composePath, "stop", service.services, environmentFiles(context)), {
            cwd: path.dirname(composePath),
            env: createBoundedRuntimeEnvironment(process.env, context.environment),
            windowsHide: true,
            timeout: 60_000,
          });
        } finally {
          managedCompose.delete(key);
        }
        const detail = commandFailureDetail(error, context.redactions);
        throw new Error(detail
          ? `Docker Compose failed to start the configured services: ${detail}`
          : "Docker Compose failed to start the configured services.");
      }
      return inspect(context);
    },
    async stop(context) {
      const service = context.service as DockerComposeEnvironmentService;
      const { composePath } = await composeMetadata(context, service);
      const key = composeKey(context);
      const managed = managedCompose.get(key);
      if (!managed || managed.composePath !== composePath || managed.projectName !== service.projectName || managed.services.join("\0") !== service.services.join("\0")) {
        throw new Error("Compose services are not verified as DevHub-owned.");
      }
      const executable = await dockerExecutable();
      await execFileAsync(executable, buildExplicitComposeCommandArgs(service.projectName, composePath, "stop", service.services, environmentFiles(context)), {
        cwd: path.dirname(composePath),
        env: createBoundedRuntimeEnvironment(process.env, context.environment),
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const status = await inspect(context);
      if (status.state === "stopped") managedCompose.delete(key);
      return status;
    },
    async probe(check, context) {
      const configured = context.service as DockerComposeEnvironmentService;
      if (!configured.services.includes(check.service)) return { healthy: false, message: `${check.service} is not part of the configured Compose service set.` };
      try {
        const { composePath } = await composeMetadata(context, configured);
        const executable = await dockerExecutable();
        const { stdout } = await execFileAsync(executable, buildExplicitComposeCommandArgs(configured.projectName, composePath, "status", configured.services, environmentFiles(context)), {
          cwd: path.dirname(composePath), windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
        });
        const row = parseComposePsRecords(stdout).find((candidate) => candidate.Service === check.service && (!candidate.Project || candidate.Project === configured.projectName));
        if (!row) return { healthy: false, message: `${check.service} is not present in the configured Compose status.` };
        if (!/^running$/i.test(row.State?.trim() ?? "")) {
          return { healthy: false, message: `${check.service} is not running.` };
        }
        if (/^healthy$/i.test(row.Health?.trim() ?? "")) return { healthy: true, message: `${check.service} is healthy.` };
        if (/^starting$/i.test(row.Health?.trim() ?? "")) {
          return { healthy: false, message: `${check.service} is running and its Docker health check is still starting.` };
        }
        if (/^unhealthy$/i.test(row.Health?.trim() ?? "")) {
          return { healthy: false, message: `${check.service} is running but Docker reports it as unhealthy.` };
        }
        return { healthy: false, message: `${check.service} is running but has not reported Docker health.` };
      } catch (error) {
        const detail = commandFailureDetail(error, context.redactions);
        return { healthy: false, message: detail
          ? `${check.service} health could not be verified: ${detail}`
          : `${check.service} health could not be verified.` };
      }
    },
  };
}

export type TrustedProcessController = {
  preflight(context: EnvironmentAdapterContext, service: TrustedProcessEnvironmentService): Promise<EnvironmentPreflightIssue[]>;
  inspect(context: EnvironmentAdapterContext, service: TrustedProcessEnvironmentService): Promise<EnvironmentServiceObservation>;
  start(context: EnvironmentAdapterContext, service: TrustedProcessEnvironmentService): Promise<EnvironmentServiceObservation>;
  stop(context: EnvironmentAdapterContext, service: TrustedProcessEnvironmentService): Promise<EnvironmentServiceObservation>;
};

function trustedProcessAdapter(controller: TrustedProcessController): EnvironmentRuntimeAdapter {
  return {
    preflight: (context) => controller.preflight(context, context.service as TrustedProcessEnvironmentService),
    inspect: (context) => controller.inspect(context, context.service as TrustedProcessEnvironmentService),
    start: (context) => controller.start(context, context.service as TrustedProcessEnvironmentService),
    stop: (context) => controller.stop(context, context.service as TrustedProcessEnvironmentService),
  };
}

export function createEnvironmentAdapterRegistry(trustedProcesses: TrustedProcessController): EnvironmentAdapterRegistry {
  return {
    node: applicationAdapter("node"),
    "spring-boot": applicationAdapter("spring-boot"),
    "docker-compose": composeAdapter(),
    process: trustedProcessAdapter(trustedProcesses),
  };
}

export function repositoryForEnvironmentService(context: EnvironmentAdapterContext, reference: string): Repository | null {
  return repositoryFor(context, reference);
}
