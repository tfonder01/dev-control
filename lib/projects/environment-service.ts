import "server-only";

import { loadEnvironmentProfileCatalog, loadManagedEnvironmentConfig, saveManagedEnvironmentConfig } from "./environment-config-store";
import type { EnvironmentProfile, WorkspaceEnvironmentConfig } from "./environment-config";
import { createEnvironmentActionHandler, type AuthorizedEnvironmentTarget } from "./environment-action-handler";
import { createWorkspaceEnvironmentOrchestrator } from "./environment-runtime";
import {
  buildEnvironmentManagementView,
  createEnvironmentManagementHandler,
  type EnvironmentManagementRequest,
} from "./environment-management";
import type { EnvironmentOperationResult } from "./environment-orchestrator";
import {
  buildEnvironmentProfileView,
  sanitizeEnvironmentDiagnostic,
  type EnvironmentActionResponse,
  type EnvironmentCatalogView,
  type EnvironmentLifecycleAction,
  workspaceView,
} from "./environment-view";
import { getWorkspaceSnapshot } from "@/lib/workspace/snapshot";
import type { Repository } from "@/lib/workspace/types";

type RuntimeEntry = {
  signature: string;
  orchestrator: ReturnType<typeof createWorkspaceEnvironmentOrchestrator>;
};

const runtimeGlobal = globalThis as typeof globalThis & { __devHubEnvironmentRuntimes?: Map<string, RuntimeEntry> };
const runtimes = runtimeGlobal.__devHubEnvironmentRuntimes ??= new Map<string, RuntimeEntry>();

function runtimeSignature(config: WorkspaceEnvironmentConfig, repositories: Repository[]) {
  return JSON.stringify({
    config,
    repositories: repositories.map((repository) => ({
      id: repository.id,
      path: repository.path,
      services: repository.services.map((service) => service.id),
    })),
  });
}

function orchestratorFor(config: WorkspaceEnvironmentConfig, repositories: Repository[]) {
  const signature = runtimeSignature(config, repositories);
  const existing = runtimes.get(config.id);
  if (existing?.signature === signature) return existing.orchestrator;
  const orchestrator = createWorkspaceEnvironmentOrchestrator(config, repositories);
  runtimes.set(config.id, { signature, orchestrator });
  return orchestrator;
}

function profileFor(config: WorkspaceEnvironmentConfig, profileId: string) {
  return config.profiles.find((profile) => profile.id === profileId) ?? null;
}

async function operationFor(
  config: WorkspaceEnvironmentConfig,
  profile: EnvironmentProfile,
  repositories: Repository[],
  action: EnvironmentLifecycleAction,
  confirmedRealData: boolean,
  launchModes: Record<string, "dev" | "preview"> = {},
) {
  const orchestrator = orchestratorFor(config, repositories);
  if (action === "inspect") {
    const [inspected, preflightIssues] = await Promise.all([
      orchestrator.inspect(profile.id),
      orchestrator.preflight(profile.id, { confirmedRealData: true }),
    ]);
    if (preflightIssues.length === 0) return inspected;
    const issues = [...inspected.issues];
    for (const issue of preflightIssues) {
      if (!issues.some((candidate) => candidate.serviceId === issue.serviceId && candidate.code === issue.code && candidate.message === issue.message)) issues.push(issue);
    }
    return { ...inspected, status: "error" as const, state: "degraded" as const, message: `${profile.name} requires attention.`, issues };
  }
  return orchestrator[action](profile.id, { confirmedRealData, launchModes });
}

function response(profile: EnvironmentProfile, result: EnvironmentOperationResult): EnvironmentActionResponse {
  return {
    status: result.status,
    message: sanitizeEnvironmentDiagnostic(result.message),
    profile: buildEnvironmentProfileView(profile, result),
  };
}

async function executeAndInspect(
  config: WorkspaceEnvironmentConfig,
  profile: EnvironmentProfile,
  repositories: Repository[],
  action: EnvironmentLifecycleAction,
  confirmedRealData: boolean,
  launchModes: Record<string, "dev" | "preview"> = {},
) {
  const result = await operationFor(config, profile, repositories, action, confirmedRealData, launchModes);
  if (action === "inspect" || result.status === "success") return result;
  const current = await operationFor(config, profile, repositories, "inspect", true);
  const issues = [...result.issues];
  for (const issue of current.issues) {
    if (!issues.some((candidate) => candidate.serviceId === issue.serviceId && candidate.code === issue.code && candidate.message === issue.message)) issues.push(issue);
  }
  return {
    ...current,
    status: result.status,
    message: result.message,
    issues,
    startedServiceIds: result.startedServiceIds,
    rolledBackServiceIds: result.rolledBackServiceIds,
  };
}

async function resolveTarget(repositoryId: string, workspaceId: string, profileId: string): Promise<AuthorizedEnvironmentTarget | null> {
  const [catalog, snapshot] = await Promise.all([loadEnvironmentProfileCatalog(), getWorkspaceSnapshot()]);
  if (!snapshot.repositories.some((repository) => repository.id === repositoryId)) return null;
  const config = catalog.workspaces.find((workspace) => workspace.id === workspaceId
    && workspace.repositories.some((reference) => reference.repositoryId === repositoryId));
  if (!config) return null;
  const profile = profileFor(config, profileId);
  if (!profile) return null;
  return {
    risk: profile.risk,
    nodeServiceIds: profile.services.filter((service) => service.adapter === "node").map((service) => service.id),
    execute: async (action, confirmedRealData, launchModes) => response(
      profile,
      await executeAndInspect(config, profile, snapshot.repositories, action, confirmedRealData, launchModes),
    ),
  };
}

const handleEnvironmentAction = createEnvironmentActionHandler(resolveTarget);

const handleEnvironmentManagement = createEnvironmentManagementHandler({
  loadCatalog: () => loadEnvironmentProfileCatalog(),
  loadManaged: () => loadManagedEnvironmentConfig(),
  saveManaged: (config, revision) => saveManagedEnvironmentConfig(config, revision),
  isStopped: async (workspace, profile) => {
    const snapshot = await getWorkspaceSnapshot();
    const result = await operationFor(workspace, profile, snapshot.repositories, "inspect", true);
    return result.services.every((service) => service.state === "stopped");
  },
});

export async function runEnvironmentAction(input: unknown) {
  try {
    return await handleEnvironmentAction(input);
  } catch {
    return { status: "error", message: "The environment action could not be completed safely.", profile: null } satisfies EnvironmentActionResponse;
  }
}

export async function manageEnvironmentProfile(input: EnvironmentManagementRequest | unknown) {
  return handleEnvironmentManagement(input);
}

export async function getEnvironmentCatalogForRepository(repositoryId: string): Promise<EnvironmentCatalogView> {
  if (!/^[A-Za-z0-9_-]{16}$/.test(repositoryId)) return { workspaces: [], error: "That repository is not available." };
  try {
    const [catalog, snapshot] = await Promise.all([loadEnvironmentProfileCatalog(), getWorkspaceSnapshot()]);
    if (!snapshot.repositories.some((repository) => repository.id === repositoryId)) return { workspaces: [], error: "That repository is no longer available." };
    const matching = catalog.workspaces.filter((workspace) => workspace.repositories.some((reference) => reference.repositoryId === repositoryId));
    const workspaces = await Promise.all(matching.map(async (config) => {
      const profiles = await Promise.all(config.profiles.map(async (profile) => buildEnvironmentProfileView(
        profile,
        await operationFor(config, profile, snapshot.repositories, "inspect", true),
      )));
      return workspaceView(config, profiles, buildEnvironmentManagementView(catalog, config));
    }));
    return { workspaces, error: null };
  } catch {
    return { workspaces: [], error: "Environment profiles could not be loaded. Review the trusted server configuration." };
  }
}
