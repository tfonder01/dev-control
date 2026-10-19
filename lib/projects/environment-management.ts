import {
  environmentServiceOrder,
  isLoopbackHost,
  parseWorkspaceEnvironmentConfig,
  type EnvironmentHealthCheck,
  type EnvironmentProfile,
  type EnvironmentService,
  type WorkspaceEnvironmentConfig,
} from "./environment-config.ts";
import type {
  EnvironmentProfileCatalog,
  EnvironmentProfileSource,
  ManagedEnvironmentConfig,
} from "./environment-config-store";

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export type ManagedHealthDraft = {
  type: "tcp" | "http" | "process" | "docker-health";
  path: string;
  expectedStatuses: number[];
  timeoutMs: number;
};

export type ManagedServiceDraft = {
  templateId: string;
  id: string;
  name: string;
  dependsOn: string[];
  host: string;
  port: number;
  launchMode: "dev" | "preview" | null;
  healthCheck: ManagedHealthDraft;
  externalEnvironmentFiles: string[];
};

export type ManagedProfileDraft = {
  id: string;
  name: string;
  risk: "local" | "real-data";
  openUrl: string;
  services: ManagedServiceDraft[];
};

export type EnvironmentManagementRequest = {
  repositoryId: string;
  workspaceId: string;
  operation: "add" | "edit" | "duplicate" | "remove";
  expectedRevision: string;
  sourceProfileId: string | null;
  confirmedRemove: boolean;
  profile: ManagedProfileDraft | null;
};

export type EnvironmentManagementResponse = {
  status: "success" | "error";
  message: string;
  fieldErrors?: Record<string, string>;
};

export type EnvironmentServiceTemplateView = {
  id: string;
  name: string;
  adapter: EnvironmentService["adapter"];
  runtimeType: string;
  defaultPort: number;
  supportsLaunchMode: boolean;
};

export type EnvironmentProfileEditorView = ManagedProfileDraft & {
  source: EnvironmentProfileSource;
};

export type EnvironmentManagementView = {
  revision: string;
  templates: EnvironmentServiceTemplateView[];
  externalEnvironmentFiles: { id: string; label: string }[];
  profiles: EnvironmentProfileEditorView[];
};

export type EnvironmentManagementDependencies = {
  loadCatalog: () => Promise<EnvironmentProfileCatalog>;
  loadManaged: () => Promise<{ config: ManagedEnvironmentConfig; revision: string }>;
  saveManaged: (config: ManagedEnvironmentConfig, revision: string) => Promise<string>;
  isStopped: (workspace: WorkspaceEnvironmentConfig, profile: EnvironmentProfile) => Promise<boolean>;
};

function templateId(profileId: string, serviceId: string) {
  return `${profileId}:${serviceId}`;
}

function healthDraft(service: EnvironmentService): ManagedHealthDraft {
  const health = service.healthChecks[0];
  if (!health) return { type: "tcp", path: "", expectedStatuses: [], timeoutMs: 30_000 };
  if (health.type === "http") {
    const url = new URL(health.url);
    return { type: "http", path: `${url.pathname}${url.search}`, expectedStatuses: health.expectedStatuses, timeoutMs: health.timeoutMs };
  }
  return { type: health.type, path: "", expectedStatuses: [], timeoutMs: health.timeoutMs };
}

function profileDraft(profile: EnvironmentProfile, source: EnvironmentProfileSource): EnvironmentProfileEditorView {
  return {
    id: profile.id,
    name: profile.name,
    risk: profile.risk,
    openUrl: profile.openUrl ?? "",
    source,
    services: profile.services.map((service) => ({
      templateId: templateId(profile.id, service.id),
      id: service.id,
      name: service.name,
      dependsOn: service.dependsOn,
      host: service.host ?? "127.0.0.1",
      port: service.port ?? 1,
      launchMode: service.adapter === "node" ? service.launchMode : null,
      healthCheck: healthDraft(service),
      externalEnvironmentFiles: service.environmentFiles
        .filter((file) => file.source === "external")
        .map((file) => file.reference),
    })),
  };
}

export function buildEnvironmentManagementView(
  catalog: EnvironmentProfileCatalog,
  workspace: WorkspaceEnvironmentConfig,
): EnvironmentManagementView {
  const trustedProfiles = catalog.trustedProfiles[workspace.id] ?? workspace.profiles;
  const templates = trustedProfiles.flatMap((profile) => profile.services.map((service): EnvironmentServiceTemplateView => ({
    id: templateId(profile.id, service.id),
    name: service.name,
    adapter: service.adapter,
    runtimeType: service.adapter === "node" ? "Node / Next.js" : service.adapter === "spring-boot" ? "Spring Boot" : service.adapter === "docker-compose" ? "Docker Compose" : "Trusted process",
    defaultPort: service.port ?? 1,
    supportsLaunchMode: service.adapter === "node",
  }))).filter((template, index, templates) => templates.findIndex((candidate) => candidate.id === template.id) === index);
  return {
    revision: catalog.revision,
    templates,
    externalEnvironmentFiles: workspace.externalEnvironmentFiles.map((reference) => ({ id: reference.id, label: reference.id })),
    profiles: workspace.profiles.map((profile) => profileDraft(profile, catalog.sources[`${workspace.id}:${profile.id}`] ?? "trusted-local")),
  };
}

function invalid(message: string, fieldErrors?: Record<string, string>): EnvironmentManagementResponse {
  return { status: "error", message, ...(fieldErrors && Object.keys(fieldErrors).length ? { fieldErrors } : {}) };
}

function validateRequest(input: unknown): EnvironmentManagementRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Partial<EnvironmentManagementRequest>;
  const allowed = new Set(["repositoryId", "workspaceId", "operation", "expectedRevision", "sourceProfileId", "confirmedRemove", "profile"]);
  if (Object.keys(input).some((key) => !allowed.has(key))
    || !REPOSITORY_ID_PATTERN.test(candidate.repositoryId ?? "")
    || !ID_PATTERN.test(candidate.workspaceId ?? "")
    || !["add", "edit", "duplicate", "remove"].includes(candidate.operation ?? "")
    || typeof candidate.expectedRevision !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(candidate.expectedRevision)
    || typeof candidate.confirmedRemove !== "boolean"
    || candidate.sourceProfileId !== null && !ID_PATTERN.test(candidate.sourceProfileId ?? "")) return null;
  return candidate as EnvironmentManagementRequest;
}

function serviceFromDraft(
  draft: ManagedServiceDraft,
  template: EnvironmentService,
  allowedExternalReferences: Set<string>,
  errors: Record<string, string>,
  index: number,
): EnvironmentService {
  const prefix = `services.${index}`;
  if (!ID_PATTERN.test(draft.id ?? "")) errors[`${prefix}.id`] = "Use a lowercase identifier with letters, numbers, and hyphens.";
  if (typeof draft.name !== "string" || !draft.name.trim() || draft.name.length > 160) errors[`${prefix}.name`] = "Enter a service name up to 160 characters.";
  if (!Array.isArray(draft.dependsOn) || draft.dependsOn.some((id) => !ID_PATTERN.test(id))) errors[`${prefix}.dependsOn`] = "Choose dependencies from this environment.";
  if (typeof draft.host !== "string" || !isLoopbackHost(draft.host)) errors[`${prefix}.host`] = "Managed profiles require a loopback host.";
  if (!Number.isSafeInteger(draft.port) || draft.port < 1 || draft.port > 65_535) errors[`${prefix}.port`] = "Choose a fixed port from 1 through 65535.";
  if (!draft.healthCheck || !["tcp", "http", "process", "docker-health"].includes(draft.healthCheck.type)) errors[`${prefix}.healthCheck`] = "Choose a supported health check.";
  if (!Array.isArray(draft.externalEnvironmentFiles) || draft.externalEnvironmentFiles.some((id) => !allowedExternalReferences.has(id))) {
    errors[`${prefix}.environmentFiles`] = "Choose only approved server-side environment references.";
  }
  const host = isLoopbackHost(draft.host ?? "") ? draft.host : "127.0.0.1";
  const port = Number.isSafeInteger(draft.port) && draft.port >= 1 && draft.port <= 65_535 ? draft.port : 1;
  const timeoutMs = Number.isSafeInteger(draft.healthCheck?.timeoutMs) && draft.healthCheck.timeoutMs >= 250 && draft.healthCheck.timeoutMs <= 300_000
    ? draft.healthCheck.timeoutMs : 30_000;
  let healthCheck: EnvironmentHealthCheck;
  if (draft.healthCheck?.type === "http") {
    const healthPath = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/.test(draft.healthCheck.path) ? draft.healthCheck.path : "/";
    if (healthPath !== draft.healthCheck.path) errors[`${prefix}.healthCheck.path`] = "Use an absolute HTTP path without a host or credentials.";
    const expectedStatuses = Array.isArray(draft.healthCheck.expectedStatuses)
      && draft.healthCheck.expectedStatuses.length > 0
      && draft.healthCheck.expectedStatuses.every((status) => Number.isInteger(status) && status >= 100 && status <= 599)
      ? [...new Set(draft.healthCheck.expectedStatuses)] : [200];
    if (expectedStatuses.length === 1 && expectedStatuses[0] === 200 && JSON.stringify(draft.healthCheck.expectedStatuses) !== "[200]") errors[`${prefix}.healthCheck.statuses`] = "Use HTTP status codes from 100 through 599.";
    healthCheck = { type: "http", url: new URL(healthPath, `http://${host}:${port}`).toString(), expectedStatuses, timeoutMs, allowInvalidCertificate: false };
  } else if (draft.healthCheck?.type === "process") {
    if (template.adapter !== "process" && template.adapter !== "node" && template.adapter !== "spring-boot") errors[`${prefix}.healthCheck`] = "Process checks are not supported by this adapter.";
    healthCheck = { type: "process", timeoutMs };
  } else if (draft.healthCheck?.type === "docker-health") {
    if (template.adapter !== "docker-compose") errors[`${prefix}.healthCheck`] = "Docker health checks require a Docker Compose adapter.";
    healthCheck = { type: "docker-health", service: template.adapter === "docker-compose" ? template.services[0] : "invalid", timeoutMs };
  } else healthCheck = { type: "tcp", host, port, timeoutMs };
  const repositoryFiles = template.environmentFiles.filter((file) => file.source === "repository");
  const environmentFiles = [...repositoryFiles, ...(draft.externalEnvironmentFiles ?? []).filter((id) => allowedExternalReferences.has(id)).map((reference) => ({ source: "external" as const, reference }))];
  const common = { ...template, id: draft.id, name: draft.name?.trim() ?? "Invalid", dependsOn: draft.dependsOn ?? [], host, port, healthChecks: [healthCheck], environmentFiles };
  if (common.adapter === "node") {
    if (draft.launchMode !== "dev" && draft.launchMode !== "preview") errors[`${prefix}.launchMode`] = "Choose Development or Preview.";
    return { ...common, launchMode: draft.launchMode === "dev" ? "dev" : "preview" };
  }
  return common;
}

function profileFromDraft(
  draft: ManagedProfileDraft,
  workspace: WorkspaceEnvironmentConfig,
  sourceProfileId: string | null,
  trustedProfiles: EnvironmentProfile[],
): { profile: EnvironmentProfile | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return { profile: null, errors: { profile: "Profile details are required." } };
  if (!ID_PATTERN.test(draft.id ?? "")) errors.id = "Use a lowercase identifier with letters, numbers, and hyphens.";
  if (typeof draft.name !== "string" || !draft.name.trim() || draft.name.length > 160) errors.name = "Enter an environment name up to 160 characters.";
  if (draft.risk !== "local" && draft.risk !== "real-data") errors.risk = "Choose development/test or real data.";
  let openUrl: string | null = null;
  if (draft.openUrl?.trim()) {
    try {
      const parsed = new URL(draft.openUrl);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !isLoopbackHost(parsed.hostname)) throw new Error();
      openUrl = parsed.toString();
    } catch { errors.openUrl = "Use a loopback HTTP or HTTPS URL without credentials."; }
  }
  if (!Array.isArray(draft.services) || draft.services.length === 0 || draft.services.length > 32) errors.services = "Add between 1 and 32 trusted services.";
  const templateMap = new Map(trustedProfiles.flatMap((profile) => profile.services.map((service) => [templateId(profile.id, service.id), service] as const)));
  const allowedExternalReferences = new Set(workspace.externalEnvironmentFiles.map((reference) => reference.id));
  const services = Array.isArray(draft.services) ? draft.services.flatMap((serviceDraft, index) => {
    const template = templateMap.get(serviceDraft?.templateId);
    if (!template) {
      errors[`services.${index}.templateId`] = "Choose a trusted discovered service adapter.";
      return [];
    }
    return [serviceFromDraft(serviceDraft, template, allowedExternalReferences, errors, index)];
  }) : [];
  const profile: EnvironmentProfile = {
    id: draft.id,
    name: draft.name?.trim() ?? "Invalid",
    risk: draft.risk === "real-data" ? "real-data" : "local",
    exclusiveGroup: workspace.profiles.find((candidate) => candidate.id === sourceProfileId)?.exclusiveGroup ?? `${workspace.id}-environment`,
    loopbackOnly: true,
    openUrl,
    services,
  };
  const parsed = parseWorkspaceEnvironmentConfig({ ...workspace, profiles: [profile] });
  if (!parsed.ok) parsed.issues.forEach((issue, index) => { errors[`schema.${index}`] = `${issue.path}: ${issue.message}`; });
  const order = environmentServiceOrder(profile);
  if (!order.ok) errors.services = `Dependency cycle detected: ${order.cycle.join(" -> ")}.`;
  return { profile: Object.keys(errors).length ? null : profile, errors };
}

function updateOverlay(
  managed: ManagedEnvironmentConfig,
  workspaceId: string,
  updater: (workspace: { id: string; profiles: EnvironmentProfile[]; removedProfileIds: string[] }) => void,
) {
  const next = structuredClone(managed);
  let workspace = next.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    workspace = { id: workspaceId, profiles: [], removedProfileIds: [] };
    next.workspaces.push(workspace);
  }
  updater(workspace);
  if (workspace.profiles.length === 0 && workspace.removedProfileIds.length === 0) next.workspaces = next.workspaces.filter((candidate) => candidate.id !== workspaceId);
  return next;
}

export function createEnvironmentManagementHandler(dependencies: EnvironmentManagementDependencies) {
  return async (input: unknown): Promise<EnvironmentManagementResponse> => {
    const request = validateRequest(input);
    if (!request) return invalid("That environment management request is not available.");
    try {
      const [catalog, managed] = await Promise.all([dependencies.loadCatalog(), dependencies.loadManaged()]);
      if (catalog.revision !== request.expectedRevision || catalog.managedRevision !== managed.revision) {
        return invalid("Environment profiles changed since this page was loaded. Refresh and review before saving again.");
      }
      const workspace = catalog.workspaces.find((candidate) => candidate.id === request.workspaceId
        && candidate.repositories.some((reference) => reference.repositoryId === request.repositoryId));
      if (!workspace) return invalid("This environment workspace is not authorized for the selected repository.");
      const source = request.sourceProfileId ? workspace.profiles.find((profile) => profile.id === request.sourceProfileId) ?? null : null;
      if ((request.operation === "edit" || request.operation === "duplicate" || request.operation === "remove") && !source) return invalid("The selected environment no longer exists.");
      if (source && (request.operation === "edit" || request.operation === "remove") && !await dependencies.isStopped(workspace, source)) {
        return invalid("Stop this environment before editing or removing it.");
      }

      if (request.operation === "remove") {
        if (!request.confirmedRemove || !source) return invalid("Confirm environment removal before continuing.");
        const sourceKind = catalog.sources[`${workspace.id}:${source.id}`];
        const next = updateOverlay(managed.config, workspace.id, (overlay) => {
          overlay.profiles = overlay.profiles.filter((profile) => profile.id !== source.id);
          if (sourceKind !== "managed" && !overlay.removedProfileIds.includes(source.id)) overlay.removedProfileIds.push(source.id);
          if (sourceKind === "managed") overlay.removedProfileIds = overlay.removedProfileIds.filter((id) => id !== source.id);
        });
        await dependencies.saveManaged(next, managed.revision);
        return { status: "success", message: `${source.name} was removed from DevHub configuration. Runtime resources and project files were not changed.` };
      }

      if (!request.profile) return invalid("Review the environment details before saving.");
      const built = profileFromDraft(request.profile, workspace, request.sourceProfileId, catalog.trustedProfiles[workspace.id] ?? workspace.profiles);
      if (!built.profile) return invalid("Review the highlighted environment settings.", built.errors);
      const existingWithTargetId = workspace.profiles.find((profile) => profile.id === built.profile!.id);
      if (request.operation !== "edit" && existingWithTargetId) return invalid("An environment already uses that identifier.", { id: "Choose a unique environment identifier." });
      if (request.operation === "edit" && existingWithTargetId && existingWithTargetId.id !== source?.id) return invalid("An environment already uses that identifier.", { id: "Choose a unique environment identifier." });

      const next = updateOverlay(managed.config, workspace.id, (overlay) => {
        if (request.operation === "edit" && source && source.id !== built.profile!.id) {
          overlay.profiles = overlay.profiles.filter((profile) => profile.id !== source.id);
          const sourceKind = catalog.sources[`${workspace.id}:${source.id}`];
          if (sourceKind !== "managed" && !overlay.removedProfileIds.includes(source.id)) overlay.removedProfileIds.push(source.id);
        }
        overlay.removedProfileIds = overlay.removedProfileIds.filter((id) => id !== built.profile!.id);
        const index = overlay.profiles.findIndex((profile) => profile.id === built.profile!.id);
        if (index >= 0) overlay.profiles[index] = built.profile!;
        else overlay.profiles.push(built.profile!);
      });
      await dependencies.saveManaged(next, managed.revision);
      const verb = request.operation === "add" ? "created" : request.operation === "duplicate" ? "duplicated" : "saved";
      return { status: "success", message: `${built.profile.name} was ${verb} in DevHub's local managed configuration.` };
    } catch (error) {
      const message = error instanceof Error && error.message.includes("changed since")
        ? error.message
        : "The environment configuration could not be saved safely. Existing configuration was preserved.";
      return invalid(message);
    }
  };
}
