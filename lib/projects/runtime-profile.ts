import "server-only";

import { access, readFile, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { SpringRuntimeStatus } from "./action-types";
import {
  databaseEndpoint,
  extractRequiredEnvironment,
  isSafeRepoRelativePath,
  isSensitiveEnvironmentName,
  mapDatasourceForHost,
  parseComposeDependencies,
  parseDevHubConfig,
  parseEnvFile,
  parseProperties,
  parseYamlScalars,
  resolvePlaceholders,
} from "./runtime-config";
import type { ProjectService, Repository } from "@/lib/workspace/types";
import type { ComposeDependencyDefinition } from "./runtime-config";

const ENV_FILES = [".env", ".env.local"] as const;
const SPRING_BASE_FILES = ["application.properties", "application.yml", "application.yaml"] as const;
const COMPOSE_FILES = ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"] as const;

export type ResolvedSpringRuntime = {
  environment: NodeJS.ProcessEnv;
  preferredPort: number | null;
  redactions: string[];
  dependencies: ResolvedComposeDependencies | null;
  status: SpringRuntimeStatus;
};

export type ResolvedComposeDependencies = {
  infrastructureId: string | null;
  composeFile: string;
  composePath: string;
  composeDirectory: string;
  services: ComposeDependencyDefinition[];
};

async function readOptional(filePath: string) {
  try {
    return await readFile(/* turbopackIgnore: true */ filePath, "utf8");
  } catch {
    return null;
  }
}

async function exists(filePath: string) {
  try {
    await access(/* turbopackIgnore: true */ filePath);
    return true;
  } catch {
    return false;
  }
}

async function trustedFile(repositoryPath: string, relativePath: string) {
  if (!isSafeRepoRelativePath(relativePath)) return null;
  try {
    const [root, candidate] = await Promise.all([
      realpath(/* turbopackIgnore: true */ repositoryPath),
      realpath(/* turbopackIgnore: true */ path.resolve(repositoryPath, relativePath)),
    ]);
    const relative = path.relative(root, candidate);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function portOpen(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
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

function configured(value: string | undefined) {
  return Boolean(value?.trim());
}

function configValue(files: Record<string, string>, key: string, environment: NodeJS.ProcessEnv) {
  for (const contents of Object.values(files).reverse()) {
    const parsed = contents.includes("=") && !contents.match(/^\s*[A-Za-z0-9_.-]+\s*:/m)
      ? parseProperties(contents)
      : parseYamlScalars(contents);
    if (parsed[key]) return resolvePlaceholders(parsed[key], environment);
  }
  return undefined;
}

export async function resolveSpringRuntime(repository: Repository, service: ProjectService): Promise<ResolvedSpringRuntime> {
  const configDirectories = service.path === repository.path ? [service.path] : [service.path, repository.path];
  const configPath = (await Promise.all(configDirectories.flatMap((directory) => ["devhub.yaml", "devhub.yml"].map(async (name) => {
    const file = path.join(/* turbopackIgnore: true */ directory, name);
    return await exists(file) ? file : null;
  })))).find(Boolean) ?? null;
  const runtimeConfig = configPath ? parseDevHubConfig(await readFile(/* turbopackIgnore: true */ configPath, "utf8")) : parseDevHubConfig("");
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const loadedFiles: string[] = [];
  let configuredEnvironmentError: string | null = null;

  const environmentDirectories = service.path === repository.path ? [repository.path] : [repository.path, service.path];
  for (const directory of environmentDirectories) {
    for (const name of ENV_FILES) {
      const relativeFile = path.relative(repository.path, path.join(/* turbopackIgnore: true */ directory, name)).replaceAll(path.sep, "/") || name;
      const file = await trustedFile(repository.path, relativeFile);
      if (!file) continue;
      Object.assign(environment, parseEnvFile(await readFile(/* turbopackIgnore: true */ file, "utf8")));
      loadedFiles.push(relativeFile);
    }
  }
  if (runtimeConfig.envFile) {
    const configBase = configPath ? path.dirname(configPath) : service.path;
    const configuredRelativePath = path.relative(repository.path, path.resolve(configBase, runtimeConfig.envFile)).replaceAll(path.sep, "/");
    const configuredFile = await trustedFile(repository.path, configuredRelativePath);
    if (configuredFile) {
      Object.assign(environment, parseEnvFile(await readFile(/* turbopackIgnore: true */ configuredFile, "utf8")));
      loadedFiles.push(configuredRelativePath);
    } else configuredEnvironmentError = `Configured environment file ${runtimeConfig.envFile} is missing or outside the repository.`;
  }

  const resources = path.join(/* turbopackIgnore: true */ service.path, "src", "main", "resources");
  const springFiles: Record<string, string> = {};
  for (const name of SPRING_BASE_FILES) {
    const contents = await readOptional(path.join(/* turbopackIgnore: true */ resources, name));
    if (contents !== null) springFiles[name] = contents;
  }
  const activeProfiles = (environment.SPRING_PROFILES_ACTIVE
    ?? configValue(springFiles, "spring.profiles.active", environment)
    ?? "").split(",").map((item) => item.trim()).filter((item) => /^[A-Za-z0-9_-]+$/.test(item));
  for (const profile of activeProfiles) {
    for (const extension of ["properties", "yml", "yaml"]) {
      const name = `application-${profile}.${extension}`;
      const contents = await readOptional(path.join(/* turbopackIgnore: true */ resources, name));
      if (contents !== null) springFiles[name] = contents;
    }
  }

  const inferredRequired = Object.values(springFiles).flatMap(extractRequiredEnvironment);
  const requiredNames = [...new Set([...runtimeConfig.requiredEnv, ...inferredRequired])];
  const missingRequired = requiredNames.filter((name) => !configured(environment[name]));
  const datasourceVariables = ["SPRING_DATASOURCE_URL", "JDBC_DATABASE_URL", "DATABASE_URL", "DB_URL"] as const;
  const datasourceVariable = datasourceVariables.find((name) => configured(environment[name])) ?? null;
  const configuredDatasourceValue = datasourceVariable
    ? environment[datasourceVariable]
    : configValue(springFiles, "spring.datasource.url", environment);
  const configuredEndpoint = databaseEndpoint(configuredDatasourceValue);

  let dependencies: ResolvedComposeDependencies | null = null;
  const colocatedCompose = COMPOSE_FILES.map((name) => ({
    id: null,
    relativePath: path.relative(repository.path, path.join(/* turbopackIgnore: true */ service.path, name)).replaceAll(path.sep, "/") || name,
  }));
  const infrastructureCompose = repository.infrastructure.length === 1
    ? [{ id: repository.infrastructure[0].id, relativePath: repository.infrastructure[0].configurationFile }]
    : [];
  const composeCandidates = [...colocatedCompose, ...infrastructureCompose]
    .filter((candidate, index, candidates) => candidates.findIndex((item) => item.relativePath.toLowerCase() === candidate.relativePath.toLowerCase()) === index);
  for (const candidate of composeCandidates) {
    const composePath = await trustedFile(repository.path, candidate.relativePath);
    if (!composePath) continue;
    const contents = await readOptional(composePath);
    if (contents === null) continue;
    const services = parseComposeDependencies(contents, environment);
    if (services.length) {
      dependencies = {
        infrastructureId: candidate.id,
        composeFile: candidate.relativePath,
        composePath,
        composeDirectory: path.dirname(composePath),
        services,
      };
      break;
    }
  }

  let datasourceValue = configuredDatasourceValue;
  const mappedDependency = configuredEndpoint && dependencies?.services.find((service) => (
    service.service.toLowerCase() === configuredEndpoint.host.toLowerCase()
    && service.containerPort === configuredEndpoint.port
    && service.hostPort !== null
  ));
  if (configuredDatasourceValue && configuredEndpoint && mappedDependency?.hostPort && mappedDependency.containerPort) {
    const mapped = mapDatasourceForHost(
      configuredDatasourceValue,
      mappedDependency.service,
      mappedDependency.containerPort,
      mappedDependency.hostPort,
    );
    if (mapped) {
      const overrideName = datasourceVariable ?? "SPRING_DATASOURCE_URL";
      environment[overrideName] = mapped;
      datasourceValue = mapped;
    }
  }
  const endpoint = databaseEndpoint(datasourceValue);

  const prerequisites: SpringRuntimeStatus["prerequisites"] = [];
  const environmentSource = loadedFiles.at(-1) ?? null;
  prerequisites.push({
    kind: "environment",
    label: "Environment",
    detail: environmentSource ?? "DevHub process environment",
    state: configuredEnvironmentError ? "blocked" : environmentSource ? "ready" : "warning",
  });
  for (const name of requiredNames.filter((item) => isSensitiveEnvironmentName(item))) {
    prerequisites.push({
      kind: "required-config",
      label: name.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase()),
      detail: configured(environment[name]) ? "Configured" : "Not configured",
      state: configured(environment[name]) ? "ready" : "blocked",
    });
  }

  let databaseBlocked = false;
  if (endpoint?.local) {
    const reachable = await portOpen(endpoint.host, endpoint.port);
    databaseBlocked = !reachable;
    prerequisites.push({
      kind: "database",
      label: "Database",
      detail: `PostgreSQL ${endpoint.host}:${endpoint.port}`,
      state: reachable ? "ready" : "blocked",
    });
  } else if (endpoint) {
    const composeNetworkHost = dependencies?.services.some((service) => service.service.toLowerCase() === endpoint.host.toLowerCase()) ?? false;
    if (composeNetworkHost) databaseBlocked = true;
    prerequisites.push({
      kind: "database",
      label: "Database",
      detail: `PostgreSQL ${endpoint.host}:${endpoint.port}${composeNetworkHost ? " (Compose network)" : ""}`,
      state: composeNetworkHost ? "blocked" : "warning",
    });
  }
  for (const prerequisitePort of runtimeConfig.prerequisitePorts) {
    if (endpoint?.local && prerequisitePort === endpoint.port) continue;
    const reachable = await portOpen("127.0.0.1", prerequisitePort);
    if (!reachable) databaseBlocked = true;
    prerequisites.push({
      kind: "database",
      label: "Local port",
      detail: `localhost:${prerequisitePort}`,
      state: reachable ? "ready" : "blocked",
    });
  }

  const expectsPostgres = endpoint !== null
    || Object.values(springFiles).some((contents) => /postgres(?:ql)?|org\.postgresql/i.test(contents))
    || dependencies?.services.some((service) => service.kind === "postgresql") === true;
  const databaseUrlMissing = expectsPostgres && !configured(datasourceValue);
  if (databaseUrlMissing) {
    prerequisites.push({ kind: "database", label: "Database", detail: "PostgreSQL URL not configured", state: "blocked" });
  }

  const message = configuredEnvironmentError
    ?? (missingRequired.length
    ? `${missingRequired[0]} is not configured for this local launch.`
    : databaseUrlMissing
      ? "A PostgreSQL datasource URL is not configured for this local launch."
    : endpoint && dependencies?.services.some((service) => service.service.toLowerCase() === endpoint.host.toLowerCase())
      ? `The datasource host ${endpoint.host} is a Docker Compose service name and is not available to a host Spring Boot launch. Configure a host-local datasource URL, then retry.`
    : databaseBlocked && endpoint?.local
      ? `PostgreSQL is not reachable at ${endpoint.host}:${endpoint.port}. Start your local database, then retry.`
      : databaseBlocked
        ? "A required local port is not reachable. Start the local dependency, then retry."
        : null);
  const redactions = Object.entries(environment)
    .filter(([name, value]) => isSensitiveEnvironmentName(name) && Boolean(value) && value!.length >= 4)
    .map(([, value]) => value!);
  const environmentPort = Number(environment.SERVER_PORT ?? environment.APP_PORT ?? environment.PORT);
  const configuredPort = runtimeConfig.port
    ?? (Number.isSafeInteger(environmentPort) ? environmentPort : service.capabilities.devPortHint);

  return {
    environment,
    preferredPort: configuredPort !== null && Number.isSafeInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65_535 ? configuredPort : null,
    redactions,
    dependencies,
    status: {
      environmentSource,
      prerequisites,
      canStart: !configuredEnvironmentError && missingRequired.length === 0 && !databaseBlocked && !databaseUrlMissing,
      message,
    },
  };
}
