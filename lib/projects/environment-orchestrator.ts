import net from "node:net";
import * as https from "node:https";
import * as tls from "node:tls";

import {
  environmentRuntimeScope,
  environmentServiceOrder,
  type DockerHealthCheck,
  type EnvironmentHealthCheck,
  type HttpHealthCheck,
  type EnvironmentProfile,
  type EnvironmentService,
  type WorkspaceEnvironmentConfig,
} from "./environment-config.ts";
import type { EnvironmentFileStatus, LoadedEnvironment } from "./environment-files";
import type { HistoricalProcessFailure } from "./action-types";
import type { Repository } from "@/lib/workspace/types";

export type EnvironmentServiceState = "stopped" | "starting" | "started" | "healthy" | "degraded";
export type EnvironmentOwnership = "none" | "devhub" | "external" | "unverified";

export type EnvironmentServiceObservation = {
  state: EnvironmentServiceState;
  ownership: EnvironmentOwnership;
  message: string;
  recentLogs?: string | null;
  exitClassification?: "managed-stop" | "unexpected-exit";
  exitCode?: number | null;
  historicalFailure?: HistoricalProcessFailure | null;
  launchMode?: "dev" | "preview" | null;
  port: number | null;
  url: string | null;
};

export type EnvironmentAdapterContext = {
  config: WorkspaceEnvironmentConfig;
  profile: EnvironmentProfile;
  service: EnvironmentService;
  repositories: Repository[];
  runtimeScope: string;
  environment: NodeJS.ProcessEnv;
  redactions: string[];
  sources: EnvironmentFileStatus[];
};

export type EnvironmentPreflightIssue = {
  serviceId: string | null;
  code: "adapter" | "confirmation" | "environment" | "external-profile" | "health" | "port" | "repository" | "service" | "trust";
  message: string;
};

export interface EnvironmentRuntimeAdapter {
  preflight(context: EnvironmentAdapterContext): Promise<EnvironmentPreflightIssue[]>;
  inspect(context: EnvironmentAdapterContext): Promise<EnvironmentServiceObservation>;
  start(context: EnvironmentAdapterContext): Promise<EnvironmentServiceObservation>;
  stop(context: EnvironmentAdapterContext, options: { graceful: true }): Promise<EnvironmentServiceObservation>;
  probe?(check: DockerHealthCheck, context: EnvironmentAdapterContext): Promise<{ healthy: boolean; message: string }>;
}

export type EnvironmentAdapterRegistry = Record<EnvironmentService["adapter"], EnvironmentRuntimeAdapter>;

export type EnvironmentOperationServiceResult = EnvironmentServiceObservation & {
  id: string;
  name: string;
};

export type EnvironmentOperationResult = {
  status: "success" | "error" | "confirmation-required";
  message: string;
  profileId: string;
  state: EnvironmentServiceState;
  services: EnvironmentOperationServiceResult[];
  issues: EnvironmentPreflightIssue[];
  startedServiceIds: string[];
  rolledBackServiceIds: string[];
};

export type EnvironmentFileProvider = {
  inspect(service: EnvironmentService): Promise<EnvironmentFileStatus[]>;
  load(service: EnvironmentService): Promise<LoadedEnvironment>;
};

export type EnvironmentHealthRunner = (
  checks: EnvironmentHealthCheck[],
  observation: EnvironmentServiceObservation,
  adapter: EnvironmentRuntimeAdapter,
  context: EnvironmentAdapterContext,
) => Promise<{ healthy: boolean; message: string }>;

export type EnvironmentOperationOptions = {
  confirmedRealData?: boolean;
  launchModes?: Record<string, "dev" | "preview">;
};

function socketReachable(host: string, port: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(Math.min(timeoutMs, 1_000));
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

type ReadinessProbeResult = { healthy: boolean; terminalMessage?: string };

async function retryProbe(probe: () => Promise<ReadinessProbeResult>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await probe();
    if (result.healthy || result.terminalMessage) return result;
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return { healthy: false };
}

async function retryDockerHealthProbe(
  probe: () => Promise<{ healthy: boolean; message: string }>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = { healthy: false, message: "Docker health has not been reported yet." };
  do {
    latest = await probe();
    if (latest.healthy) return latest;
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  } while (Date.now() < deadline);
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  return {
    healthy: false,
    message: `Docker health did not become ready within ${seconds} seconds. Last check: ${latest.message}`,
  };
}

export function strictHttpsHealthOptions(trustStore: HttpHealthCheck["trustStore"]) {
  if (trustStore !== "system") return { rejectUnauthorized: true as const };
  const certificateProvider = tls as typeof tls & { getCACertificates?: (type: "system") => string[] };
  if (!certificateProvider.getCACertificates) throw new Error("The Node runtime cannot read the system certificate store.");
  return { rejectUnauthorized: true as const, ca: certificateProvider.getCACertificates("system") };
}

function httpsStatusReachable(check: HttpHealthCheck, requestTimeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let request: ReturnType<typeof https.request>;
    try {
      request = https.request(check.url, {
        method: "GET",
        timeout: requestTimeoutMs,
        ...strictHttpsHealthOptions(check.trustStore),
      }, (response) => {
        response.resume();
        finish(check.expectedStatuses.includes(response.statusCode ?? 0));
      });
    } catch {
      finish(false);
      return;
    }
    request.once("timeout", () => request.destroy(new Error("HTTPS health check timed out.")));
    request.once("error", () => finish(false));
    request.end();
  });
}

export const runEnvironmentHealthChecks: EnvironmentHealthRunner = async (checks, observation, adapter, context) => {
  if (observation.state === "stopped" || observation.state === "degraded") {
    return { healthy: false, message: observation.historicalFailure?.message ?? observation.message };
  }
  if (checks.length === 0) {
    return {
      healthy: observation.state === "healthy" || observation.state === "started",
      message: observation.message,
    };
  }
  const managedProcessReadinessFailure = async () => {
    if (context.service.adapter !== "node" && context.service.adapter !== "spring-boot" && context.service.adapter !== "process") return null;
    const current = await adapter.inspect(context);
    if (current.state === "stopped" || current.state === "degraded") {
      return current.historicalFailure?.message ?? current.message;
    }
    if (observation.ownership === "devhub" && current.ownership !== "devhub") {
      return "DevHub can no longer verify ownership of the process that is becoming ready.";
    }
    return null;
  };
  const guardedProbe = async (probe: () => Promise<boolean>): Promise<ReadinessProbeResult> => {
    const before = await managedProcessReadinessFailure();
    if (before) return { healthy: false, terminalMessage: before };
    if (!await probe()) return { healthy: false };
    const after = await managedProcessReadinessFailure();
    return after ? { healthy: false, terminalMessage: after } : { healthy: true };
  };
  for (const check of checks) {
    if (check.type === "process") {
      const failure = await managedProcessReadinessFailure();
      if (failure) return { healthy: false, message: failure };
      continue;
    }
    if (check.type === "docker-health") {
      if (!adapter.probe) return { healthy: false, message: "The adapter does not support Docker health checks." };
      const result = await retryDockerHealthProbe(() => adapter.probe!(check, context), check.timeoutMs);
      if (!result.healthy) return result;
      continue;
    }
    if (check.type === "tcp") {
      const result = await retryProbe(() => guardedProbe(() => socketReachable(check.host, check.port, check.timeoutMs)), check.timeoutMs);
      if (!result.healthy) return { healthy: false, message: result.terminalMessage ?? `TCP readiness failed for ${check.host}:${check.port}.` };
      continue;
    }
    const result = await retryProbe(() => guardedProbe(async () => {
      if (new URL(check.url).protocol === "https:" && check.trustStore === "system") {
        return httpsStatusReachable(check, Math.min(check.timeoutMs, 2_000));
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(check.timeoutMs, 2_000));
      try {
        const response = await fetch(check.url, { signal: controller.signal, redirect: "manual", cache: "no-store" });
        return check.expectedStatuses.includes(response.status);
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
      }
    }), check.timeoutMs);
    if (!result.healthy) return { healthy: false, message: result.terminalMessage ?? `HTTP readiness failed for ${new URL(check.url).origin}.` };
  }
  return { healthy: true, message: "All configured health checks passed." };
};

function profileState(observations: EnvironmentOperationServiceResult[]): EnvironmentServiceState {
  if (observations.length === 0 || observations.every((item) => item.state === "stopped")) return "stopped";
  if (observations.some((item) => item.state === "degraded" || item.ownership === "unverified")) return "degraded";
  if (observations.some((item) => item.state === "starting")) return "starting";
  if (observations.every((item) => item.state === "healthy")) return "healthy";
  return "started";
}

function safeFailureMessage(error: unknown) {
  if (!(error instanceof Error)) return "The environment operation failed.";
  return error.message.split(/\r?\n/)[0].slice(0, 300) || "The environment operation failed.";
}

export class EnvironmentOrchestrator {
  private operations = new Map<string, { kind: "start" | "stop" | "restart"; promise: Promise<EnvironmentOperationResult> }>();
  private readonly config: WorkspaceEnvironmentConfig;
  private readonly repositories: Repository[];
  private readonly adapters: EnvironmentAdapterRegistry;
  private readonly environmentFiles: EnvironmentFileProvider;
  private readonly healthRunner: EnvironmentHealthRunner;

  constructor(
    config: WorkspaceEnvironmentConfig,
    repositories: Repository[],
    adapters: EnvironmentAdapterRegistry,
    environmentFiles: EnvironmentFileProvider,
    healthRunner: EnvironmentHealthRunner = runEnvironmentHealthChecks,
  ) {
    this.config = config;
    this.repositories = repositories;
    this.adapters = adapters;
    this.environmentFiles = environmentFiles;
    this.healthRunner = healthRunner;
  }

  private profile(profileId: string) {
    return this.config.profiles.find((profile) => profile.id === profileId) ?? null;
  }

  private repositoryIssues(profile: EnvironmentProfile) {
    const available = new Set(this.repositories.map((repository) => repository.id));
    const references = new Map(this.config.repositories.map((reference) => [reference.id, reference.repositoryId]));
    const issues: EnvironmentPreflightIssue[] = [];
    for (const service of profile.services) {
      const serviceReferences = [
        ...(service.adapter !== "process" ? [service.repository] : service.repository ? [service.repository] : []),
        ...(service.adapter === "process" && "repository" in service.workingDirectory ? [service.workingDirectory.repository] : []),
      ];
      for (const reference of serviceReferences) {
        const repositoryId = references.get(reference);
        if (!repositoryId || !available.has(repositoryId)) issues.push({ serviceId: service.id, code: "repository", message: `Repository reference ${reference} is unavailable.` });
      }
      if ((service.adapter === "node" || service.adapter === "spring-boot")) {
        const repositoryId = references.get(service.repository);
        const repository = this.repositories.find((candidate) => candidate.id === repositoryId);
        if (repository && !repository.services.some((candidate) => candidate.id === service.serviceId)) {
          issues.push({ serviceId: service.id, code: "service", message: `Configured service ${service.id} is unavailable in the current workspace snapshot.` });
        }
      }
    }
    return issues;
  }

  private async context(
    profile: EnvironmentProfile,
    service: EnvironmentService,
    loadEnvironment: boolean,
    launchModes: Record<string, "dev" | "preview"> = {},
  ) {
    const effectiveService = service.adapter === "node" && launchModes[service.id]
      ? { ...service, launchMode: launchModes[service.id] }
      : service;
    const loaded: LoadedEnvironment = loadEnvironment
      ? await this.environmentFiles.load(effectiveService)
      : { environment: {} as NodeJS.ProcessEnv, redactions: [], sources: await this.environmentFiles.inspect(effectiveService) };
    return {
      config: this.config,
      profile,
      service: effectiveService,
      repositories: this.repositories,
      runtimeScope: environmentRuntimeScope(this.config.id, profile.id),
      environment: { ...loaded.environment, ...effectiveService.environment },
      redactions: loaded.redactions,
      sources: loaded.sources,
    };
  }

  async preflight(profileId: string, options: EnvironmentOperationOptions = {}) {
    const profile = this.profile(profileId);
    if (!profile) return [{ serviceId: null, code: "service", message: "The environment profile is unavailable." }] satisfies EnvironmentPreflightIssue[];
    const issues = this.repositoryIssues(profile);
    if (profile.risk === "real-data" && options.confirmedRealData !== true) {
      issues.push({ serviceId: null, code: "confirmation", message: `${profile.name} requires explicit real-data confirmation.` });
    }
    for (const service of profile.services) {
      const context = await this.context(profile, service, false, options.launchModes);
      for (const source of context.sources) {
        if (!source.available) issues.push({ serviceId: service.id, code: "environment", message: source.message });
      }
      const adapter = this.adapters[service.adapter];
      issues.push(...await adapter.preflight(context));
      const observation = await adapter.inspect(context);
      if (observation.ownership === "unverified") {
        issues.push({ serviceId: service.id, code: "port", message: `${service.name} has an unverified listener, port conflict, or runtime identity.` });
      } else if (observation.state !== "stopped") {
        if (context.service.adapter === "node" && observation.launchMode && observation.launchMode !== context.service.launchMode) {
          issues.push({ serviceId: service.id, code: "service", message: `${service.name} is running in ${observation.launchMode === "preview" ? "Preview" : "Development"} mode. Use Restart Environment to apply ${context.service.launchMode === "preview" ? "Preview" : "Development"} mode.` });
          continue;
        }
        const health = await this.healthRunner(service.healthChecks, observation, adapter, context);
        if (!health.healthy) issues.push({ serviceId: service.id, code: "health", message: `${service.name}: ${health.message}` });
      }
    }
    if (profile.exclusiveGroup) {
      for (const other of this.config.profiles.filter((candidate) => candidate.id !== profile.id && candidate.exclusiveGroup === profile.exclusiveGroup)) {
        for (const service of other.services) {
          const context = await this.context(other, service, false);
          const observation = await this.adapters[service.adapter].inspect(context);
          if (observation.state !== "stopped") {
            const reason = observation.ownership === "unverified"
              ? `could not be verified: ${observation.message}`
              : observation.ownership === "external"
                ? "is running externally"
                : observation.ownership === "devhub"
                  ? "is running in this DevHub session"
                  : `reported ${observation.state}`;
            issues.push({
              serviceId: service.id,
              code: "external-profile",
              message: `${other.name} blocks ${profile.name}: ${service.name} ${reason}. Stop that service before starting ${profile.name}.`,
            });
            break;
          }
        }
      }
    }
    return issues;
  }

  async inspect(profileId: string): Promise<EnvironmentOperationResult> {
    const profile = this.profile(profileId);
    if (!profile) return this.failure(profileId, "The environment profile is unavailable.");
    const order = environmentServiceOrder(profile);
    if (!order.ok) return this.failure(profileId, "The environment dependency graph is invalid.");
    const services: EnvironmentOperationServiceResult[] = [];
    const issues: EnvironmentPreflightIssue[] = [];
    for (const service of order.startup) {
      const context = await this.context(profile, service, false);
      const adapter = this.adapters[service.adapter];
      let current = await adapter.inspect(context);
      if (current.ownership === "unverified") {
        current = { ...current, state: "degraded" };
        issues.push({ serviceId: service.id, code: "trust", message: current.message });
      } else if (current.state !== "stopped") {
        const health = await this.healthRunner(service.healthChecks, current, adapter, context);
        current = {
          ...current,
          state: health.healthy && service.healthChecks.length > 0 ? "healthy" : health.healthy ? current.state : "degraded",
          message: health.message,
        };
        if (!health.healthy) issues.push({ serviceId: service.id, code: "health", message: `${service.name}: ${health.message}` });
      }
      services.push({ ...current, id: service.id, name: service.name });
    }
    return {
      status: issues.length ? "error" : "success",
      message: issues.length ? `${profile.name} is degraded.` : `${profile.name} status inspected.`,
      profileId,
      state: profileState(services),
      services,
      issues,
      startedServiceIds: [],
      rolledBackServiceIds: [],
    };
  }

  private runExclusive(profileId: string, kind: "start" | "stop" | "restart", operation: () => Promise<EnvironmentOperationResult>): Promise<EnvironmentOperationResult> {
    const key = `${this.config.id}:${profileId}`;
    const current = this.operations.get(key);
    if (current) {
      if (current.kind === kind) return current.promise;
      return current.promise.then(() => this.runExclusive(profileId, kind, operation));
    }
    const pending = operation().finally(() => {
      if (this.operations.get(key)?.promise === pending) this.operations.delete(key);
    });
    this.operations.set(key, { kind, promise: pending });
    return pending;
  }

  start(profileId: string, options: EnvironmentOperationOptions = {}) {
    return this.runExclusive(profileId, "start", () => this.startOnce(profileId, options));
  }

  private async startOnce(profileId: string, options: EnvironmentOperationOptions) {
    const profile = this.profile(profileId);
    if (!profile) return this.failure(profileId, "The environment profile is unavailable.");
    const issues = await this.preflight(profileId, options);
    if (issues.length > 0) {
      return {
        ...this.failure(profileId, issues[0].message, issues),
        status: issues.every((candidate) => candidate.code === "confirmation") ? "confirmation-required" as const : "error" as const,
      };
    }
    const order = environmentServiceOrder(profile);
    if (!order.ok) return this.failure(profileId, "The environment dependency graph is invalid.");
    const results: EnvironmentOperationServiceResult[] = [];
    const started: { service: EnvironmentService; context: EnvironmentAdapterContext }[] = [];
    const rolledBackServiceIds: string[] = [];

    try {
      for (const service of order.startup) {
        const context = await this.context(profile, service, true, options.launchModes);
        if (context.sources.some((source) => !source.available)) throw new Error(`Environment files for ${service.name} became unavailable.`);
        const adapter = this.adapters[service.adapter];
        let observation = await adapter.inspect(context);
        if (observation.ownership === "unverified") throw new Error(`${service.name} has an unverified listener or runtime conflict.`);
        const wasStopped = observation.state === "stopped";
        if (wasStopped) observation = await adapter.start(context);
        if (wasStopped && observation.ownership !== "devhub") {
          throw new Error(`${service.name}: ${observation.historicalFailure?.message ?? observation.message}`);
        }
        if (observation.state === "stopped" || observation.state === "degraded") {
          throw new Error(`${service.name}: ${observation.historicalFailure?.message ?? observation.message}`);
        }
        if (wasStopped && observation.ownership === "devhub") started.push({ service, context });
        const health = await this.healthRunner(service.healthChecks, observation, adapter, context);
        if (!health.healthy) throw new Error(`${service.name}: ${health.message}`);
        observation = {
          ...observation,
          state: service.healthChecks.length > 0 ? "healthy" : observation.state,
          message: health.message,
        };
        results.push({ ...observation, id: service.id, name: service.name });
      }
      return {
        status: "success" as const,
        message: `${profile.name} is healthy.`,
        profileId,
        state: profileState(results),
        services: results,
        issues: [],
        startedServiceIds: started.map((entry) => entry.service.id),
        rolledBackServiceIds,
      };
    } catch (error) {
      for (const entry of [...started].reverse()) {
        try {
          const observation = await this.adapters[entry.service.adapter].inspect(entry.context);
          if (observation.ownership !== "devhub") continue;
          const stopped = await this.adapters[entry.service.adapter].stop(entry.context, { graceful: true });
          if (stopped.state === "stopped") rolledBackServiceIds.push(entry.service.id);
        } catch {
          // The operation result reports exactly which newly started services rolled back.
        }
      }
      return {
        status: "error" as const,
        message: safeFailureMessage(error),
        profileId,
        state: "degraded" as const,
        services: results,
        issues: [{ serviceId: null, code: "health" as const, message: safeFailureMessage(error) }],
        startedServiceIds: started.map((entry) => entry.service.id),
        rolledBackServiceIds,
      };
    }
  }

  stop(profileId: string, options: EnvironmentOperationOptions = {}) {
    return this.runExclusive(profileId, "stop", () => this.stopOnce(profileId, options));
  }

  restart(profileId: string, options: EnvironmentOperationOptions = {}) {
    return this.runExclusive(profileId, "restart", async () => {
      const stopped = await this.stopOnce(profileId, options);
      if (stopped.status !== "success") return stopped;
      return this.startOnce(profileId, options);
    });
  }

  private async stopOnce(profileId: string, options: { confirmedRealData?: boolean }) {
    const profile = this.profile(profileId);
    if (!profile) return this.failure(profileId, "The environment profile is unavailable.");
    if (profile.risk === "real-data" && options.confirmedRealData !== true) {
      const confirmation = { serviceId: null, code: "confirmation" as const, message: `${profile.name} requires explicit real-data confirmation.` };
      return { ...this.failure(profileId, confirmation.message, [confirmation]), status: "confirmation-required" as const };
    }
    const order = environmentServiceOrder(profile);
    if (!order.ok) return this.failure(profileId, "The environment dependency graph is invalid.");
    const services: EnvironmentOperationServiceResult[] = [];
    const issues: EnvironmentPreflightIssue[] = [];
    for (const service of order.shutdown) {
      const context = await this.context(profile, service, false);
      const adapter = this.adapters[service.adapter];
      let observation = await adapter.inspect(context);
      if (observation.state === "stopped" || observation.ownership === "external") {
        services.push({ ...observation, id: service.id, name: service.name });
        continue;
      }
      if (observation.ownership !== "devhub") {
        issues.push({ serviceId: service.id, code: "trust", message: `${service.name} is not verified as DevHub-owned and was not stopped.` });
        services.push({ ...observation, id: service.id, name: service.name });
        continue;
      }
      try {
        observation = await adapter.stop(context, { graceful: true });
        if (observation.state !== "stopped") issues.push({ serviceId: service.id, code: "health", message: `${service.name} did not stop cleanly.` });
      } catch (error) {
        observation = { ...observation, state: "degraded", message: safeFailureMessage(error) };
        issues.push({ serviceId: service.id, code: "health", message: `${service.name} could not be stopped gracefully.` });
      }
      services.push({ ...observation, id: service.id, name: service.name });
    }
    const externalServicesRemain = services.some((service) => service.ownership === "external" && service.state !== "stopped");
    return {
      status: issues.length ? "error" as const : "success" as const,
      message: issues.length
        ? `One or more ${profile.name} services could not be stopped safely.`
        : externalServicesRemain
          ? `${profile.name} DevHub-owned services are stopped; external services remain running.`
          : `${profile.name} is stopped.`,
      profileId,
      state: profileState(services),
      services,
      issues,
      startedServiceIds: [],
      rolledBackServiceIds: [],
    };
  }

  private failure(profileId: string, message: string, issues: EnvironmentPreflightIssue[] = []): EnvironmentOperationResult {
    return { status: "error", message, profileId, state: "degraded", services: [], issues, startedServiceIds: [], rolledBackServiceIds: [] };
  }
}
