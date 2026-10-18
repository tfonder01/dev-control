import type { EnvironmentLifecycleAction, EnvironmentActionResponse } from "./environment-view";

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const ACTIONS = new Set<EnvironmentLifecycleAction>(["inspect", "start", "stop", "restart"]);

export type EnvironmentActionRequest = {
  repositoryId: string;
  workspaceId: string;
  profileId: string;
  action: EnvironmentLifecycleAction;
  confirmedRealData: boolean;
  launchModes?: Record<string, "dev" | "preview">;
};

export type AuthorizedEnvironmentTarget = {
  risk: "local" | "real-data";
  nodeServiceIds: string[];
  execute(action: EnvironmentLifecycleAction, confirmedRealData: boolean, launchModes: Record<string, "dev" | "preview">): Promise<EnvironmentActionResponse>;
};

export function invalidEnvironmentAction(message = "That environment action is not available."): EnvironmentActionResponse {
  return { status: "error", message, profile: null };
}

export function createEnvironmentActionHandler(resolveTarget: (
  repositoryId: string,
  workspaceId: string,
  profileId: string,
) => Promise<AuthorizedEnvironmentTarget | null>) {
  return async (input: unknown): Promise<EnvironmentActionResponse> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalidEnvironmentAction();
    const allowedKeys = new Set(["repositoryId", "workspaceId", "profileId", "action", "confirmedRealData", "launchModes"]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) return invalidEnvironmentAction();
    const candidate = input as Partial<EnvironmentActionRequest>;
    if (!REPOSITORY_ID_PATTERN.test(candidate.repositoryId ?? "")
      || !ID_PATTERN.test(candidate.workspaceId ?? "")
      || !ID_PATTERN.test(candidate.profileId ?? "")
      || !ACTIONS.has(candidate.action as EnvironmentLifecycleAction)
      || typeof candidate.confirmedRealData !== "boolean") {
      return invalidEnvironmentAction();
    }
    const launchModes = candidate.launchModes ?? {};
    if (!launchModes || typeof launchModes !== "object" || Array.isArray(launchModes)
      || Object.keys(launchModes).length > 32
      || Object.entries(launchModes).some(([serviceId, mode]) => !ID_PATTERN.test(serviceId) || mode !== "dev" && mode !== "preview")) {
      return invalidEnvironmentAction();
    }
    const target = await resolveTarget(candidate.repositoryId!, candidate.workspaceId!, candidate.profileId!);
    if (!target) return invalidEnvironmentAction("The environment profile is not authorized for this repository.");
    if (Object.keys(launchModes).some((serviceId) => !target.nodeServiceIds.includes(serviceId))) {
      return invalidEnvironmentAction("The requested frontend mode is not authorized for this environment profile.");
    }
    if (candidate.action !== "inspect" && target.risk === "real-data" && candidate.confirmedRealData !== true) {
      return { status: "confirmation-required", message: "Explicit confirmation is required for this real-data environment.", profile: null };
    }
    return target.execute(candidate.action!, candidate.confirmedRealData, launchModes);
  };
}
