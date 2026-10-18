import path from "node:path";
import { isIP } from "node:net";

export const ENVIRONMENT_CONFIG_VERSION = 1 as const;

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMPOSE_SERVICE_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type EnvironmentIdentifier = string;

export type WorkspaceRepositoryReference = {
  id: EnvironmentIdentifier;
  repositoryId: string;
};

export type ExternalEnvironmentFileReference = {
  id: EnvironmentIdentifier;
  pathVariable: string;
  relativePath: string | null;
};

export type EnvironmentFileReference =
  | { source: "repository"; repository: EnvironmentIdentifier; path: string }
  | { source: "external"; reference: EnvironmentIdentifier };

export type TcpHealthCheck = {
  type: "tcp";
  host: string;
  port: number;
  timeoutMs: number;
};

export type HttpHealthCheck = {
  type: "http";
  url: string;
  expectedStatuses: number[];
  timeoutMs: number;
  allowInvalidCertificate: false;
};

export type ProcessHealthCheck = {
  type: "process";
  timeoutMs: number;
};

export type DockerHealthCheck = {
  type: "docker-health";
  service: string;
  timeoutMs: number;
};

export type EnvironmentHealthCheck = TcpHealthCheck | HttpHealthCheck | ProcessHealthCheck | DockerHealthCheck;

type EnvironmentServiceBase = {
  id: EnvironmentIdentifier;
  name: string;
  dependsOn: EnvironmentIdentifier[];
  environment: Record<string, string>;
  environmentFiles: EnvironmentFileReference[];
  healthChecks: EnvironmentHealthCheck[];
  host: string | null;
  port: number | null;
};

export type NodeEnvironmentService = EnvironmentServiceBase & {
  adapter: "node";
  repository: EnvironmentIdentifier;
  serviceId: string;
  launchMode: "dev" | "preview";
};

export type SpringBootEnvironmentService = EnvironmentServiceBase & {
  adapter: "spring-boot";
  repository: EnvironmentIdentifier;
  serviceId: string;
  springProfile: string | null;
};

export type DockerComposeEnvironmentService = EnvironmentServiceBase & {
  adapter: "docker-compose";
  repository: EnvironmentIdentifier;
  composeFile: string;
  services: string[];
  projectName: string;
};

export type TrustedProcessEnvironmentService = EnvironmentServiceBase & {
  adapter: "process";
  repository: EnvironmentIdentifier | null;
  executable: string;
  args: string[];
  workingDirectory: { repository: EnvironmentIdentifier; path: string } | { externalPathVariable: string };
  stop: { executable: string; args: string[] } | null;
};

export type EnvironmentService =
  | NodeEnvironmentService
  | SpringBootEnvironmentService
  | DockerComposeEnvironmentService
  | TrustedProcessEnvironmentService;

export type EnvironmentProfile = {
  id: EnvironmentIdentifier;
  name: string;
  risk: "local" | "real-data";
  exclusiveGroup: EnvironmentIdentifier | null;
  loopbackOnly: boolean;
  openUrl: string | null;
  services: EnvironmentService[];
};

export type WorkspaceEnvironmentConfig = {
  version: typeof ENVIRONMENT_CONFIG_VERSION;
  id: EnvironmentIdentifier;
  name: string;
  repositories: WorkspaceRepositoryReference[];
  externalEnvironmentFiles: ExternalEnvironmentFileReference[];
  profiles: EnvironmentProfile[];
};

export type WorkspaceEnvironmentConfigFile = {
  version: typeof ENVIRONMENT_CONFIG_VERSION;
  workspaces: WorkspaceEnvironmentConfig[];
};

export type EnvironmentConfigIssue = { path: string; message: string };

export type EnvironmentConfigParseResult =
  | { ok: true; config: WorkspaceEnvironmentConfig }
  | { ok: false; issues: EnvironmentConfigIssue[] };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function issue(issues: EnvironmentConfigIssue[], issuePath: string, message: string) {
  issues.push({ path: issuePath, message });
}

function rejectUnknownKeys(value: UnknownRecord, allowed: readonly string[], issuePath: string, issues: EnvironmentConfigIssue[]) {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issue(issues, `${issuePath}.${key}`, "Unknown configuration property.");
  }
}

function identifier(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[]) {
  if (typeof value === "string" && ID_PATTERN.test(value)) return value;
  issue(issues, issuePath, "Must be a stable lowercase identifier using letters, numbers, and hyphens.");
  return "invalid-id";
}

function nonEmptyString(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[]) {
  if (typeof value === "string" && value.trim() && value.length <= 160) return value.trim();
  issue(issues, issuePath, "Must be a non-empty string no longer than 160 characters.");
  return "Invalid";
}

function validPort(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[], optional = true) {
  if (value === undefined || value === null) {
    if (!optional) issue(issues, issuePath, "A fixed port is required.");
    return null;
  }
  if (Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65_535) return Number(value);
  issue(issues, issuePath, "Must be an integer from 1 through 65535.");
  return null;
}

function safeRelativePath(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[]) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    issue(issues, issuePath, "Must be a non-empty relative path.");
    return ".";
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    issue(issues, issuePath, "Path traversal outside the trusted root is not allowed.");
    return ".";
  }
  return value.replaceAll("\\", "/");
}

function stringArray(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[], pattern?: RegExp) {
  if (!Array.isArray(value)) {
    issue(issues, issuePath, "Must be an array.");
    return [];
  }
  const result: string[] = [];
  value.forEach((candidate, index) => {
    if (typeof candidate !== "string" || !candidate.trim() || (pattern && !pattern.test(candidate))) {
      issue(issues, `${issuePath}[${index}]`, "Contains an invalid value.");
    } else result.push(candidate);
  });
  return result;
}

function parseFixedEnvironment(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[]) {
  if (value === undefined) return {};
  const item = record(value);
  if (!item) {
    issue(issues, issuePath, "Must be an object of non-secret fixed environment values.");
    return {};
  }
  const result: Record<string, string> = {};
  for (const [name, candidate] of Object.entries(item)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      issue(issues, `${issuePath}.${name}`, "Must use a valid environment variable name.");
      continue;
    }
    if (/(secret|password|passwd|token|api_?key|private_?key|credential)/i.test(name)) {
      issue(issues, `${issuePath}.${name}`, "Secret values must use an environment-file reference.");
      continue;
    }
    if (typeof candidate !== "string" || candidate.length > 2_000 || /[\r\n\0]/.test(candidate)
      || /:\/\/[^\s/:]+:[^\s/@]+@/.test(candidate)) {
      issue(issues, `${issuePath}.${name}`, "Must be a bounded non-secret string without control characters or embedded credentials.");
      continue;
    }
    result[name] = candidate;
  }
  return result;
}

export function isLoopbackHost(host: string) {
  const normalized = host.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(normalized) || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

function parseEnvironmentFiles(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(issues, issuePath, "Must be an array.");
    return [];
  }
  return value.flatMap((candidate, index): EnvironmentFileReference[] => {
    const itemPath = `${issuePath}[${index}]`;
    const item = record(candidate);
    if (!item) {
      issue(issues, itemPath, "Must be an object.");
      return [];
    }
    if (item.source === "repository") {
      rejectUnknownKeys(item, ["source", "repository", "path"], itemPath, issues);
      return [{
        source: "repository",
        repository: identifier(item.repository, `${itemPath}.repository`, issues),
        path: safeRelativePath(item.path, `${itemPath}.path`, issues),
      }];
    }
    if (item.source === "external") {
      rejectUnknownKeys(item, ["source", "reference"], itemPath, issues);
      return [{ source: "external", reference: identifier(item.reference, `${itemPath}.reference`, issues) }];
    }
    issue(issues, `${itemPath}.source`, "Must be repository or external.");
    return [];
  });
}

function parseHealthChecks(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(issues, issuePath, "Must be an array.");
    return [];
  }
  return value.flatMap((candidate, index): EnvironmentHealthCheck[] => {
    const itemPath = `${issuePath}[${index}]`;
    const item = record(candidate);
    if (!item) {
      issue(issues, itemPath, "Must be an object.");
      return [];
    }
    const timeoutMs = item.timeoutMs === undefined ? 30_000 : Number(item.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 300_000) {
      issue(issues, `${itemPath}.timeoutMs`, "Must be an integer from 250 through 300000.");
    }
    const safeTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 250 && timeoutMs <= 300_000 ? timeoutMs : 30_000;
    if (item.type === "tcp") {
      rejectUnknownKeys(item, ["type", "host", "port", "timeoutMs"], itemPath, issues);
      return [{
        type: "tcp",
        host: nonEmptyString(item.host, `${itemPath}.host`, issues),
        port: validPort(item.port, `${itemPath}.port`, issues, false) ?? 1,
        timeoutMs: safeTimeout,
      }];
    }
    if (item.type === "http") {
      rejectUnknownKeys(item, ["type", "url", "expectedStatuses", "timeoutMs", "allowInvalidCertificate"], itemPath, issues);
      let url = "http://localhost";
      try {
        const parsed = new URL(String(item.url));
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
        url = parsed.toString();
      } catch {
        issue(issues, `${itemPath}.url`, "Must be an HTTP or HTTPS URL without embedded credentials.");
      }
      const statuses = item.expectedStatuses === undefined ? [200] : stringArray(
        Array.isArray(item.expectedStatuses) ? item.expectedStatuses.map(String) : item.expectedStatuses,
        `${itemPath}.expectedStatuses`,
        issues,
        /^[1-5]\d\d$/,
      ).map(Number);
      if (item.allowInvalidCertificate !== undefined && item.allowInvalidCertificate !== false) {
        issue(issues, `${itemPath}.allowInvalidCertificate`, "Invalid TLS certificates cannot be allowed.");
      }
      return [{ type: "http", url, expectedStatuses: statuses, timeoutMs: safeTimeout, allowInvalidCertificate: false }];
    }
    if (item.type === "process") {
      rejectUnknownKeys(item, ["type", "timeoutMs"], itemPath, issues);
      return [{ type: "process", timeoutMs: safeTimeout }];
    }
    if (item.type === "docker-health") {
      rejectUnknownKeys(item, ["type", "service", "timeoutMs"], itemPath, issues);
      const service = typeof item.service === "string" && COMPOSE_SERVICE_PATTERN.test(item.service)
        ? item.service
        : "invalid";
      if (service === "invalid") issue(issues, `${itemPath}.service`, "Must be a valid Compose service name.");
      return [{ type: "docker-health", service, timeoutMs: safeTimeout }];
    }
    issue(issues, `${itemPath}.type`, "Unsupported health-check type.");
    return [];
  });
}

function parseService(value: unknown, issuePath: string, issues: EnvironmentConfigIssue[]): EnvironmentService | null {
  const item = record(value);
  if (!item) {
    issue(issues, issuePath, "Must be an object.");
    return null;
  }
  const commonKeys = ["id", "name", "adapter", "dependsOn", "environment", "environmentFiles", "healthChecks", "host", "port"];
  const id = identifier(item.id, `${issuePath}.id`, issues);
  const name = nonEmptyString(item.name, `${issuePath}.name`, issues);
  const dependsOn = item.dependsOn === undefined ? [] : stringArray(item.dependsOn, `${issuePath}.dependsOn`, issues, ID_PATTERN);
  const environment = parseFixedEnvironment(item.environment, `${issuePath}.environment`, issues);
  const environmentFiles = parseEnvironmentFiles(item.environmentFiles, `${issuePath}.environmentFiles`, issues);
  const healthChecks = parseHealthChecks(item.healthChecks, `${issuePath}.healthChecks`, issues);
  const host = item.host === undefined || item.host === null ? null : nonEmptyString(item.host, `${issuePath}.host`, issues);
  const port = validPort(item.port, `${issuePath}.port`, issues);
  const base = { id, name, dependsOn, environment, environmentFiles, healthChecks, host, port };

  if (item.adapter === "node") {
    rejectUnknownKeys(item, [...commonKeys, "repository", "serviceId", "launchMode"], issuePath, issues);
    const launchMode = item.launchMode === "preview" ? "preview" : "dev";
    if (item.launchMode !== "dev" && item.launchMode !== "preview") issue(issues, `${issuePath}.launchMode`, "Must be dev or preview.");
    if (typeof item.serviceId !== "string" || !REPOSITORY_ID_PATTERN.test(item.serviceId)) issue(issues, `${issuePath}.serviceId`, "Must be a stable 16-character service identifier.");
    return { ...base, adapter: "node", repository: identifier(item.repository, `${issuePath}.repository`, issues), serviceId: String(item.serviceId ?? ""), launchMode };
  }
  if (item.adapter === "spring-boot") {
    rejectUnknownKeys(item, [...commonKeys, "repository", "serviceId", "springProfile"], issuePath, issues);
    if (typeof item.serviceId !== "string" || !REPOSITORY_ID_PATTERN.test(item.serviceId)) issue(issues, `${issuePath}.serviceId`, "Must be a stable 16-character service identifier.");
    const springProfile = item.springProfile === undefined || item.springProfile === null
      ? null
      : identifier(item.springProfile, `${issuePath}.springProfile`, issues);
    return { ...base, adapter: "spring-boot", repository: identifier(item.repository, `${issuePath}.repository`, issues), serviceId: String(item.serviceId ?? ""), springProfile };
  }
  if (item.adapter === "docker-compose") {
    rejectUnknownKeys(item, [...commonKeys, "repository", "composeFile", "services", "projectName"], issuePath, issues);
    const projectName = typeof item.projectName === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(item.projectName)
      ? item.projectName
      : "invalid";
    if (projectName === "invalid") issue(issues, `${issuePath}.projectName`, "Must be an explicit safe Compose project name.");
    const services = stringArray(item.services, `${issuePath}.services`, issues, COMPOSE_SERVICE_PATTERN);
    if (services.length === 0) issue(issues, `${issuePath}.services`, "At least one explicit Compose service is required.");
    return {
      ...base,
      adapter: "docker-compose",
      repository: identifier(item.repository, `${issuePath}.repository`, issues),
      composeFile: safeRelativePath(item.composeFile, `${issuePath}.composeFile`, issues),
      services,
      projectName,
    };
  }
  if (item.adapter === "process") {
    rejectUnknownKeys(item, [...commonKeys, "repository", "executable", "args", "workingDirectory", "stop"], issuePath, issues);
    if (typeof item.executable !== "string" || !item.executable.trim() || /[\r\n\0]/.test(item.executable)) issue(issues, `${issuePath}.executable`, "Must be a trusted executable path or name.");
    const args = stringArray(item.args ?? [], `${issuePath}.args`, issues);
    if (args.some((arg) => /[\r\n\0]/.test(arg))) issue(issues, `${issuePath}.args`, "Arguments cannot contain control characters.");
    if (args.some((arg) => /(?:secret|password|passwd|token|api_?key|private_?key|credential)\s*=/i.test(arg) || /:\/\/[^\s/:]+:[^\s/@]+@/.test(arg))) {
      issue(issues, `${issuePath}.args`, "Secret-bearing command arguments are not allowed; use an environment file reference.");
    }
    const workingDirectory = record(item.workingDirectory);
    let parsedWorkingDirectory: TrustedProcessEnvironmentService["workingDirectory"] = { externalPathVariable: "INVALID_PATH" };
    if (workingDirectory?.repository !== undefined) {
      rejectUnknownKeys(workingDirectory, ["repository", "path"], `${issuePath}.workingDirectory`, issues);
      parsedWorkingDirectory = {
        repository: identifier(workingDirectory.repository, `${issuePath}.workingDirectory.repository`, issues),
        path: safeRelativePath(workingDirectory.path, `${issuePath}.workingDirectory.path`, issues),
      };
    } else if (typeof workingDirectory?.externalPathVariable === "string" && ENVIRONMENT_NAME_PATTERN.test(workingDirectory.externalPathVariable)) {
      rejectUnknownKeys(workingDirectory, ["externalPathVariable"], `${issuePath}.workingDirectory`, issues);
      parsedWorkingDirectory = { externalPathVariable: workingDirectory.externalPathVariable };
    } else issue(issues, `${issuePath}.workingDirectory`, "Must reference a repository path or owner-controlled external path variable.");
    let stop: TrustedProcessEnvironmentService["stop"] = null;
    if (item.stop !== undefined && item.stop !== null) {
      const stopValue = record(item.stop);
      if (!stopValue) issue(issues, `${issuePath}.stop`, "Must be an object.");
      else {
        rejectUnknownKeys(stopValue, ["executable", "args"], `${issuePath}.stop`, issues);
        if (typeof stopValue.executable !== "string" || !stopValue.executable.trim() || /[\r\n\0]/.test(stopValue.executable)) issue(issues, `${issuePath}.stop.executable`, "Must be a trusted executable path or name.");
        const stopArgs = stringArray(stopValue.args ?? [], `${issuePath}.stop.args`, issues);
        if (stopArgs.some((arg) => /[\r\n\0]/.test(arg))) issue(issues, `${issuePath}.stop.args`, "Arguments cannot contain control characters.");
        if (stopArgs.some((arg) => /(?:secret|password|passwd|token|api_?key|private_?key|credential)\s*=/i.test(arg) || /:\/\/[^\s/:]+:[^\s/@]+@/.test(arg))) {
          issue(issues, `${issuePath}.stop.args`, "Secret-bearing command arguments are not allowed; use an environment file reference.");
        }
        stop = { executable: String(stopValue.executable ?? ""), args: stopArgs };
      }
    }
    return {
      ...base,
      adapter: "process",
      repository: item.repository === undefined || item.repository === null ? null : identifier(item.repository, `${issuePath}.repository`, issues),
      executable: String(item.executable ?? ""),
      args,
      workingDirectory: parsedWorkingDirectory,
      stop,
    };
  }
  issue(issues, `${issuePath}.adapter`, "Unsupported adapter.");
  return null;
}

function validateUniqueIds(values: { id: string }[], issuePath: string, issues: EnvironmentConfigIssue[]) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) issue(issues, `${issuePath}[${index}].id`, `Duplicate identifier ${value.id}.`);
    seen.add(value.id);
  });
}

export function environmentServiceOrder(profile: EnvironmentProfile) {
  const services = new Map(profile.services.map((service) => [service.id, service]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: EnvironmentService[] = [];
  const cycle: string[] = [];

  function visit(id: string, trail: string[]): boolean {
    if (visited.has(id)) return true;
    if (visiting.has(id)) {
      const start = trail.indexOf(id);
      cycle.push(...trail.slice(start), id);
      return false;
    }
    const service = services.get(id);
    if (!service) return true;
    visiting.add(id);
    for (const dependency of [...service.dependsOn].sort()) {
      if (!visit(dependency, [...trail, id])) return false;
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(service);
    return true;
  }

  for (const id of [...services.keys()].sort()) {
    if (!visit(id, [])) return { ok: false as const, cycle };
  }
  return { ok: true as const, startup: ordered, shutdown: [...ordered].reverse() };
}

export function parseWorkspaceEnvironmentConfig(input: unknown): EnvironmentConfigParseResult {
  const issues: EnvironmentConfigIssue[] = [];
  const root = record(input);
  if (!root) return { ok: false, issues: [{ path: "$", message: "Configuration must be an object." }] };
  rejectUnknownKeys(root, ["version", "id", "name", "repositories", "externalEnvironmentFiles", "profiles"], "$", issues);
  if (root.version !== ENVIRONMENT_CONFIG_VERSION) issue(issues, "$.version", `Only version ${ENVIRONMENT_CONFIG_VERSION} is supported.`);
  const id = identifier(root.id, "$.id", issues);
  const name = nonEmptyString(root.name, "$.name", issues);

  const repositories: WorkspaceRepositoryReference[] = Array.isArray(root.repositories)
    ? root.repositories.flatMap((candidate, index) => {
        const itemPath = `$.repositories[${index}]`;
        const item = record(candidate);
        if (!item) {
          issue(issues, itemPath, "Must be an object.");
          return [];
        }
        rejectUnknownKeys(item, ["id", "repositoryId"], itemPath, issues);
        if (typeof item.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(item.repositoryId)) issue(issues, `${itemPath}.repositoryId`, "Must be a stable 16-character repository identifier.");
        return [{ id: identifier(item.id, `${itemPath}.id`, issues), repositoryId: String(item.repositoryId ?? "") }];
      })
    : (issue(issues, "$.repositories", "Must be an array."), []);
  validateUniqueIds(repositories, "$.repositories", issues);
  const repositoryIds = new Set(repositories.map((repository) => repository.id));

  const externalEnvironmentFiles: ExternalEnvironmentFileReference[] = root.externalEnvironmentFiles === undefined
    ? []
    : Array.isArray(root.externalEnvironmentFiles)
      ? root.externalEnvironmentFiles.flatMap((candidate, index) => {
          const itemPath = `$.externalEnvironmentFiles[${index}]`;
          const item = record(candidate);
          if (!item) {
            issue(issues, itemPath, "Must be an object.");
            return [];
          }
          rejectUnknownKeys(item, ["id", "pathVariable", "relativePath"], itemPath, issues);
          if (typeof item.pathVariable !== "string" || !ENVIRONMENT_NAME_PATTERN.test(item.pathVariable)) issue(issues, `${itemPath}.pathVariable`, "Must name an owner-controlled environment variable.");
          const relativePath = item.relativePath === undefined || item.relativePath === null
            ? null
            : safeRelativePath(item.relativePath, `${itemPath}.relativePath`, issues);
          return [{ id: identifier(item.id, `${itemPath}.id`, issues), pathVariable: String(item.pathVariable ?? ""), relativePath }];
        })
      : (issue(issues, "$.externalEnvironmentFiles", "Must be an array."), []);
  validateUniqueIds(externalEnvironmentFiles, "$.externalEnvironmentFiles", issues);
  const externalIds = new Set(externalEnvironmentFiles.map((reference) => reference.id));

  const profiles: EnvironmentProfile[] = Array.isArray(root.profiles)
    ? root.profiles.flatMap((candidate, index) => {
        const itemPath = `$.profiles[${index}]`;
        const item = record(candidate);
        if (!item) {
          issue(issues, itemPath, "Must be an object.");
          return [];
        }
        rejectUnknownKeys(item, ["id", "name", "risk", "exclusiveGroup", "loopbackOnly", "openUrl", "services"], itemPath, issues);
        const profileId = identifier(item.id, `${itemPath}.id`, issues);
        const profileName = nonEmptyString(item.name, `${itemPath}.name`, issues);
        const risk = item.risk === "real-data" ? "real-data" : "local";
        if (item.risk !== "local" && item.risk !== "real-data") issue(issues, `${itemPath}.risk`, "Must be local or real-data.");
        const exclusiveGroup = item.exclusiveGroup === undefined || item.exclusiveGroup === null
          ? null
          : identifier(item.exclusiveGroup, `${itemPath}.exclusiveGroup`, issues);
        if (typeof item.loopbackOnly !== "boolean") issue(issues, `${itemPath}.loopbackOnly`, "Must be a boolean.");
        const loopbackOnly = item.loopbackOnly === true;
        let openUrl: string | null = null;
        if (item.openUrl !== undefined && item.openUrl !== null) {
          try {
            const parsed = new URL(String(item.openUrl));
            if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error();
            if (loopbackOnly && !isLoopbackHost(parsed.hostname)) issue(issues, `${itemPath}.openUrl`, "Loopback-only profiles require a loopback Open App URL.");
            openUrl = parsed.toString();
          } catch {
            issue(issues, `${itemPath}.openUrl`, "Must be an HTTP or HTTPS URL without embedded credentials.");
          }
        }
        const services = Array.isArray(item.services)
          ? item.services.map((service, serviceIndex) => parseService(service, `${itemPath}.services[${serviceIndex}]`, issues)).filter((service): service is EnvironmentService => service !== null)
          : (issue(issues, `${itemPath}.services`, "Must be an array."), []);
        validateUniqueIds(services, `${itemPath}.services`, issues);
        const serviceIds = new Set(services.map((service) => service.id));
        services.forEach((service, serviceIndex) => {
          service.dependsOn.forEach((dependency, dependencyIndex) => {
            if (!serviceIds.has(dependency)) issue(issues, `${itemPath}.services[${serviceIndex}].dependsOn[${dependencyIndex}]`, `Unknown service ${dependency}.`);
            if (dependency === service.id) issue(issues, `${itemPath}.services[${serviceIndex}].dependsOn[${dependencyIndex}]`, "A service cannot depend on itself.");
          });
          const referencedRepositories = [
            ...(service.adapter === "process" && service.repository ? [service.repository] : []),
            ...(service.adapter !== "process" ? [service.repository] : []),
            ...(service.adapter === "process" && "repository" in service.workingDirectory ? [service.workingDirectory.repository] : []),
            ...service.environmentFiles.filter((file): file is Extract<EnvironmentFileReference, { source: "repository" }> => file.source === "repository").map((file) => file.repository),
          ];
          referencedRepositories.forEach((repository) => {
            if (!repositoryIds.has(repository)) issue(issues, `${itemPath}.services[${serviceIndex}]`, `Unknown repository reference ${repository}.`);
          });
          service.environmentFiles.filter((file): file is Extract<EnvironmentFileReference, { source: "external" }> => file.source === "external").forEach((file) => {
            if (!externalIds.has(file.reference)) issue(issues, `${itemPath}.services[${serviceIndex}].environmentFiles`, `Unknown external environment reference ${file.reference}.`);
          });
          if (service.port === null) {
            issue(issues, `${itemPath}.services[${serviceIndex}].port`, "Runtime services require an explicit fixed port.");
          }
          if (loopbackOnly) {
            if (service.host && !isLoopbackHost(service.host)) issue(issues, `${itemPath}.services[${serviceIndex}].host`, "Loopback-only profiles require a loopback host.");
            service.healthChecks.forEach((health, healthIndex) => {
              if (health.type === "tcp" && !isLoopbackHost(health.host)) issue(issues, `${itemPath}.services[${serviceIndex}].healthChecks[${healthIndex}].host`, "Loopback-only profiles require loopback health checks.");
              if (health.type === "http" && !isLoopbackHost(new URL(health.url).hostname)) issue(issues, `${itemPath}.services[${serviceIndex}].healthChecks[${healthIndex}].url`, "Loopback-only profiles require loopback health checks.");
            });
          }
        });
        const seenPorts = new Map<string, string>();
        services.forEach((service, serviceIndex) => {
          if (!service.port) return;
          const configuredHost = service.host ?? "127.0.0.1";
          const key = `${isLoopbackHost(configuredHost) ? "loopback" : configuredHost.toLowerCase()}:${service.port}`;
          const prior = seenPorts.get(key);
          if (prior) issue(issues, `${itemPath}.services[${serviceIndex}].port`, `Conflicts with service ${prior} in this profile.`);
          seenPorts.set(key, service.id);
        });
        const profile: EnvironmentProfile = { id: profileId, name: profileName, risk, exclusiveGroup, loopbackOnly, openUrl, services };
        const order = environmentServiceOrder(profile);
        if (!order.ok) issue(issues, `${itemPath}.services`, `Dependency cycle detected: ${order.cycle.join(" -> ")}.`);
        return [profile];
      })
    : (issue(issues, "$.profiles", "Must be an array."), []);
  validateUniqueIds(profiles, "$.profiles", issues);

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, config: { version: ENVIRONMENT_CONFIG_VERSION, id, name, repositories, externalEnvironmentFiles, profiles } };
}

export function environmentRuntimeScope(workspaceId: string, profileId: string) {
  if (!ID_PATTERN.test(workspaceId) || !ID_PATTERN.test(profileId)) throw new Error("Invalid environment runtime scope.");
  return `${workspaceId}:${profileId}`;
}

export function parseWorkspaceEnvironmentConfigFile(input: unknown):
  | { ok: true; config: WorkspaceEnvironmentConfigFile }
  | { ok: false; issues: EnvironmentConfigIssue[] } {
  const root = record(input);
  if (!root) return { ok: false, issues: [{ path: "$", message: "Configuration file must be an object." }] };
  const issues: EnvironmentConfigIssue[] = [];
  rejectUnknownKeys(root, ["version", "workspaces"], "$", issues);
  if (root.version !== ENVIRONMENT_CONFIG_VERSION) issue(issues, "$.version", `Only version ${ENVIRONMENT_CONFIG_VERSION} is supported.`);
  if (!Array.isArray(root.workspaces)) issue(issues, "$.workspaces", "Must be an array.");
  const workspaces: WorkspaceEnvironmentConfig[] = [];
  if (Array.isArray(root.workspaces)) {
    root.workspaces.forEach((candidate, index) => {
      const parsed = parseWorkspaceEnvironmentConfig(candidate);
      if (parsed.ok) workspaces.push(parsed.config);
      else parsed.issues.forEach((candidateIssue) => issues.push({
        path: `$.workspaces[${index}]${candidateIssue.path === "$" ? "" : candidateIssue.path.slice(1)}`,
        message: candidateIssue.message,
      }));
    });
  }
  validateUniqueIds(workspaces, "$.workspaces", issues);
  return issues.length ? { ok: false, issues } : { ok: true, config: { version: ENVIRONMENT_CONFIG_VERSION, workspaces } };
}
