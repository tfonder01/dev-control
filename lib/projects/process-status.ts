import type { DevServerStatus } from "./action-types";
import type { EnvironmentServiceObservation } from "./environment-orchestrator";

export function clearHistoricalProcessOwnership(status: DevServerStatus, failedAt = new Date().toISOString()): DevServerStatus {
  if (status.exitClassification !== "unexpected-exit") return status;
  const historicalFailure = status.historicalFailure ?? {
    message: status.message,
    output: status.output,
    exitCode: status.exitCode ?? null,
    failedAt,
  };
  return {
    ...status,
    state: "stopped",
    ownedByDevHub: false,
    url: null,
    message: "Stopped",
    output: undefined,
    exitClassification: undefined,
    exitCode: undefined,
    historicalFailure,
  };
}

export function managedProcessObservation(status: DevServerStatus): EnvironmentServiceObservation {
  status = clearHistoricalProcessOwnership(status);
  const historicalFailure = status.historicalFailure ?? null;
  return {
    state: status.state === "stopped" ? "stopped"
      : status.state === "starting" ? "starting"
        : status.state === "running" || status.state === "external" ? "started"
          : "degraded",
    ownership: status.ownedByDevHub ? "devhub"
      : status.state === "external" ? "external"
        : status.state === "stopped" ? "none"
          : "unverified",
    message: status.message,
    recentLogs: status.ownedByDevHub ? status.output ?? null : null,
    exitClassification: status.exitClassification,
    exitCode: status.exitCode,
    historicalFailure,
    launchMode: status.launchMode,
    port: status.port,
    url: status.url,
  };
}
