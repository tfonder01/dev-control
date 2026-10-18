import type { EnvironmentProfile, WorkspaceEnvironmentConfig } from "./environment-config";
import type { NodeLaunchMode } from "./action-types";
import type {
  EnvironmentOperationResult,
  EnvironmentOwnership,
  EnvironmentServiceState,
} from "./environment-orchestrator";

export type EnvironmentLifecycleAction = "inspect" | "start" | "stop" | "restart";

export type EnvironmentServiceView = {
  id: string;
  name: string;
  runtimeType: "Node / Next.js" | "Spring Boot" | "Docker Compose" | "Local process";
  port: number | null;
  url: string | null;
  state: EnvironmentServiceState;
  ownership: EnvironmentOwnership;
  stage: string;
  endpoint: string | null;
  diagnostic: string;
  exitSummary: string | null;
  recentLogs: string | null;
  defaultLaunchMode: NodeLaunchMode | null;
  runningLaunchMode: NodeLaunchMode | null;
};

export type EnvironmentProfileView = {
  id: string;
  name: string;
  risk: "local" | "real-data";
  openUrl: string | null;
  state: EnvironmentServiceState;
  services: EnvironmentServiceView[];
  guidance: string[];
};

export type EnvironmentWorkspaceView = {
  id: string;
  name: string;
  profiles: EnvironmentProfileView[];
};

export type EnvironmentCatalogView = {
  workspaces: EnvironmentWorkspaceView[];
  error: string | null;
};

export type EnvironmentActionResponse = {
  status: "success" | "error" | "confirmation-required";
  message: string;
  profile: EnvironmentProfileView | null;
};

const runtimeLabels: Record<EnvironmentProfile["services"][number]["adapter"], EnvironmentServiceView["runtimeType"]> = {
  node: "Node / Next.js",
  "spring-boot": "Spring Boot",
  "docker-compose": "Docker Compose",
  process: "Local process",
};

export function sanitizeEnvironmentDiagnostic(value: string) {
  return value
    .split(/\r?\n/)[0]
    .replace(/:\/\/([^\s/:]+):([^\s/@]+)@/g, "://$1:[REDACTED]@")
    .replace(/\b(authorization|password|passwd|secret|token|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .slice(0, 300) || "No diagnostic details are available.";
}

export function sanitizeEnvironmentLogTail(value: string | null | undefined) {
  if (!value) return null;
  const sanitized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line
      .replace(/:\/\/([^\s/:]+):([^\s/@]+)@/g, "://$1:[REDACTED]@")
      .replace(/\b(authorization|password|passwd|secret|token|api[_-]?key|credential|account(?:Id|Number)?|routing(?:Number)?|amount)\b"?\s*[:=]\s*"?[^\s,;\"}]+/gi, "$1=[REDACTED]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]"))
    .filter((line) => line.trim().length > 0)
    .slice(-12)
    .join("\n")
    .slice(-2_000)
    .trim();
  return sanitized || null;
}

function serviceStage(state: EnvironmentServiceState, ownership: EnvironmentOwnership) {
  if (state === "stopped") return "Stopped";
  if (state === "starting") return "Startup";
  if (state === "healthy") return "Health check";
  if (state === "started") return "Runtime verification";
  return ownership === "devhub" ? "Startup / health" : "Identity verification";
}

function exitSummary(classification: "managed-stop" | "unexpected-exit" | undefined, exitCode: number | null | undefined) {
  if (!classification) return null;
  const code = exitCode === null || exitCode === undefined ? "an unreported exit code" : `exit code ${exitCode}`;
  return classification === "managed-stop"
    ? `Managed shutdown verified; the process wrapper reported ${code} during termination.`
    : `Unexpected process exit with ${code}.`;
}

export function environmentRecoveryGuidance(result: EnvironmentOperationResult) {
  const guidance = new Set<string>();
  for (const issue of result.issues) {
    if (/docker/i.test(issue.message)) guidance.add("Start Docker Desktop and verify the Docker CLI is available, then refresh the profile status.");
    if (/certificate|\bcaddy\b|\bhttps\b/i.test(issue.message)) guidance.add("Verify the configured local certificate authority and proxy trust before retrying.");
    if (issue.code === "adapter") guidance.add("Verify the required local runtime is installed and available, then inspect the profile again.");
    if (issue.code === "environment") guidance.add("Restore the configured owner-controlled environment file; DevHub will not copy or display its contents.");
    if (issue.code === "port" || issue.code === "trust") guidance.add("Inspect the reported port owner. Stop it outside DevHub or free the configured port; DevHub will not terminate an unverified listener.");
    if (issue.code === "external-profile") guidance.add("Stop the mutually exclusive environment first, then retry.");
    if (issue.code === "health") guidance.add("Check the affected service locally, correct its configuration, and retry. Services started by this failed attempt are rolled back when ownership is verified.");
    if (issue.code === "repository" || issue.code === "service") guidance.add("Refresh the workspace so DevHub can resolve the configured repository and service identifiers.");
    if (issue.code === "confirmation") guidance.add("Acknowledge the real-data warning before running this lifecycle action.");
  }
  if (result.rolledBackServiceIds.length > 0) guidance.add("DevHub rolled back only services newly started by this operation; external services were left running.");
  return [...guidance];
}

export function buildEnvironmentProfileView(
  profile: EnvironmentProfile,
  result: EnvironmentOperationResult,
): EnvironmentProfileView {
  const observations = new Map(result.services.map((service) => [service.id, service]));
  return {
    id: profile.id,
    name: profile.name,
    risk: profile.risk,
    openUrl: profile.openUrl,
    state: result.state,
    services: profile.services.map((service) => {
      const observed = observations.get(service.id);
      return {
        id: service.id,
        name: service.name,
        runtimeType: runtimeLabels[service.adapter],
        port: service.port,
        url: observed?.url ?? null,
        state: observed?.state ?? "degraded",
        ownership: observed?.ownership ?? "unverified",
        stage: serviceStage(observed?.state ?? "degraded", observed?.ownership ?? "unverified"),
        endpoint: service.host && service.port ? `${service.host}:${service.port}` : null,
        diagnostic: sanitizeEnvironmentDiagnostic(observed?.message ?? "Service status is unavailable."),
        exitSummary: exitSummary(observed?.exitClassification, observed?.exitCode),
        recentLogs: observed?.ownership === "devhub" ? sanitizeEnvironmentLogTail(observed.recentLogs) : null,
        defaultLaunchMode: service.adapter === "node" ? service.launchMode : null,
        runningLaunchMode: service.adapter === "node" && observed?.state !== "stopped" ? observed?.launchMode ?? null : null,
      };
    }),
    guidance: environmentRecoveryGuidance(result),
  };
}

export function environmentControlState(profile: EnvironmentProfileView, pending: boolean) {
  const hasOwnedService = profile.services.some((service) => service.ownership === "devhub" && service.state !== "stopped");
  const hasUnverifiedService = profile.services.some((service) => service.ownership === "unverified");
  return {
    canStart: !pending && profile.state !== "healthy" && !hasUnverifiedService,
    canStop: !pending && hasOwnedService,
    canRestart: !pending && hasOwnedService && !hasUnverifiedService,
    canOpen: !pending && Boolean(profile.openUrl) && (profile.state === "healthy" || profile.state === "started"),
  };
}

export function workspaceView(
  config: WorkspaceEnvironmentConfig,
  profiles: EnvironmentProfileView[],
): EnvironmentWorkspaceView {
  return { id: config.id, name: config.name, profiles };
}
