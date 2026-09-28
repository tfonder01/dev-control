import path from "node:path";

export type DevHubRuntimeConfig = {
  envFile: string | null;
  port: number | null;
  requiredEnv: string[];
  prerequisitePorts: number[];
  dockerCompose: boolean | null;
};

export function parseEnvFile(contents: string) {
  const values: Record<string, string> = {};
  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function scalar(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function validPort(value: string) {
  const port = Number(scalar(value));
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function parseDevHubConfig(contents: string): DevHubRuntimeConfig {
  const config: DevHubRuntimeConfig = {
    envFile: null,
    port: null,
    requiredEnv: [],
    prerequisitePorts: [],
    dockerCompose: null,
  };
  let section = "";
  let list = "";

  for (const rawLine of contents.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const line = withoutComment.trim();
    if (indent === 0 && line.endsWith(":")) {
      section = line.slice(0, -1);
      list = "";
      continue;
    }
    const item = line.match(/^-\s+(.+)$/)?.[1];
    if (item && section === "prerequisites") {
      if (list === "requiredEnv" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(scalar(item))) config.requiredEnv.push(scalar(item));
      if (list === "ports") {
        const port = validPort(item);
        if (port) config.prerequisitePorts.push(port);
      }
      continue;
    }
    const property = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/);
    if (!property) continue;
    const [, key, rawValue] = property;
    if (!rawValue) {
      list = key;
      continue;
    }
    list = "";
    if (section === "development" && key === "envFile") config.envFile = scalar(rawValue);
    if (section === "development" && key === "port") config.port = validPort(rawValue);
    if (section === "prerequisites" && key === "dockerCompose" && /^(true|false)$/i.test(rawValue)) {
      config.dockerCompose = rawValue.toLowerCase() === "true";
    }
  }
  return config;
}

export function isSafeRepoRelativePath(value: string) {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

export function extractRequiredEnvironment(contents: string) {
  const required = new Set<string>();
  for (const match of contents.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g)) {
    if (!match[2].startsWith(":")) required.add(match[1]);
  }
  return [...required];
}

export function resolvePlaceholders(value: string, environment: NodeJS.ProcessEnv) {
  return scalar(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    return environment[name] ?? fallback ?? "";
  });
}

export function parseProperties(contents: string) {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!][^:=\s]*)\s*[:=]\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function parseYamlScalars(contents: string) {
  const values: Record<string, string> = {};
  const stack: { indent: number; key: string }[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const match = rawLine.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = [...stack.map((item) => item.key), match[2]].join(".");
    const value = match[3].replace(/\s+#.*$/, "").trim();
    if (value) values[key] = value;
    else stack.push({ indent, key: match[2] });
  }
  return values;
}

export function databaseEndpoint(value: string | undefined) {
  if (!value) return null;
  const match = value.match(/^(?:jdbc:)?(postgres(?:ql)?|mysql):\/\/([^/:?#]+)(?::(\d+))?/i);
  if (!match) return null;
  const port = Number(match[3] ?? (/mysql/i.test(match[1]) ? 3306 : 5432));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  return { type: /mysql/i.test(match[1]) ? "mysql" as const : "postgresql" as const, host: match[2], port, local: /^(localhost|127\.0\.0\.1|::1)$/i.test(match[2]) };
}

export function isSensitiveEnvironmentName(name: string) {
  return /(secret|password|passwd|token|api_?key|private_?key|credential)/i.test(name);
}

export function isNodeProfileSelector(name: string) {
  return /(?:^|_)(?:DEMO|MOCK)(?:_|$)/i.test(name)
    || /(?:^|_)(?:APP_MODE|APP_ENV|ENVIRONMENT|PROFILE|SPRING_PROFILES_ACTIVE)$/i.test(name);
}

export function safeProfileState(name: string, value: string) {
  const normalized = value.trim().toLowerCase();
  if (/^(true|1|yes|on|demo)$/.test(normalized) && /(?:^|_)(?:DEMO|MOCK)(?:_|$)/i.test(name)) return "Demo";
  if (/^(false|0|no|off)$/.test(normalized) && /(?:^|_)(?:DEMO|MOCK)(?:_|$)/i.test(name)) return "Disabled";
  if (/^(demo|demonstration)$/.test(normalized)) return "Demo";
  if (/^(prod|production|prd)$/.test(normalized)) return "Production";
  if (/^(dev|development)$/.test(normalized)) return "Development";
  if (/^(local|localhost)$/.test(normalized)) return "Local";
  if (/^(stage|staging|stg)$/.test(normalized)) return "Staging";
  if (/^(test|testing)$/.test(normalized)) return "Test";
  return value.trim() ? "Custom" : "Unset";
}

export type ComposeDependencyDefinition = {
  service: string;
  kind: "postgresql" | "mysql" | "redis" | "rabbitmq" | "kafka";
  displayName: string;
  containerPort: number | null;
  hostPort: number | null;
  hasHealthcheck: boolean;
};

function composeServices(contents: string) {
  const services: { name: string; block: string[] }[] = [];
  let inServices = false;
  let current: { name: string; block: string[] } | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (/^services:\s*(?:#.*)?$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim()) break;
    const service = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/)?.[1];
    if (service) {
      current = { name: service, block: [] };
      services.push(current);
    } else if (current) current.block.push(line);
  }

  return services;
}

function dependencyKind(name: string, block: string): ComposeDependencyDefinition["kind"] | null {
  const image = scalar(block.match(/^\s+image\s*:\s*(.*?)\s*$/m)?.[1] ?? "").toLowerCase();
  const service = name.toLowerCase();
  if (/(?:^|[\/_-])postgres(?:ql)?(?::|$)/.test(image) || /postgres/.test(service) && /POSTGRES_(?:DB|USER|PASSWORD)/i.test(block)) return "postgresql";
  if (/(?:^|[\/_-])(?:mysql|mariadb)(?::|$)/.test(image) || /(?:mysql|mariadb)/.test(service) && /MYSQL_(?:DATABASE|USER|PASSWORD|ROOT_PASSWORD)/i.test(block)) return "mysql";
  if (/(?:^|[\/_-])redis(?::|$)/.test(image) || /redis/.test(service) && /REDIS_(?:PASSWORD|PORT)/i.test(block)) return "redis";
  if (/(?:^|[\/_-])rabbitmq(?::|$)/.test(image) || /rabbit/.test(service) && /RABBITMQ_(?:DEFAULT_USER|DEFAULT_PASS)/i.test(block)) return "rabbitmq";
  if (/(?:^|[\/_-])kafka(?::|$)/.test(image) || /kafka/.test(service) && /KAFKA_(?:BROKER_ID|LISTENERS|ADVERTISED_LISTENERS)/i.test(block)) return "kafka";
  return null;
}

function resolvedComposePort(value: string, environment: NodeJS.ProcessEnv) {
  const cleaned = scalar(value);
  const placeholder = cleaned.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]+))?\}$/);
  const resolved = placeholder ? environment[placeholder[1]] ?? placeholder[2] ?? "" : cleaned;
  const port = Number(resolved);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function publishedPort(block: string, environment: NodeJS.ProcessEnv) {
  for (const line of block.split(/\r?\n/)) {
    const short = line.match(/^\s+-\s+["']?(?:(?:127\.0\.0\.1|localhost):)?(.+?):(\d{2,5})["']?\s*$/);
    if (!short) continue;
    const hostPort = resolvedComposePort(short[1], environment);
    const containerPort = Number(short[2]);
    if (hostPort && containerPort >= 1 && containerPort <= 65_535) return { hostPort, containerPort };
  }
  const long = block.match(/^\s+target\s*:\s*["']?(\d{2,5})["']?[\s\S]*?^\s+published\s*:\s*["']?([^\s"']+)["']?/m)
    ?? block.match(/^\s+published\s*:\s*["']?([^\s"']+)["']?[\s\S]*?^\s+target\s*:\s*["']?(\d{2,5})["']?/m);
  if (!long) return { hostPort: null, containerPort: null };
  const targetFirst = /^\d+$/.test(long[1]);
  return {
    containerPort: Number(targetFirst ? long[1] : long[2]),
    hostPort: resolvedComposePort(targetFirst ? long[2] : long[1], environment),
  };
}

export function parseComposeDependencies(contents: string, environment: NodeJS.ProcessEnv) {
  const dependencies: ComposeDependencyDefinition[] = [];
  for (const candidate of composeServices(contents)) {
    const block = candidate.block.join("\n");
    const kind = dependencyKind(candidate.name, block);
    if (!kind) continue;
    const ports = publishedPort(block, environment);
    const displayNames: Record<ComposeDependencyDefinition["kind"], string> = {
      postgresql: "PostgreSQL",
      mysql: "MySQL",
      redis: "Redis",
      rabbitmq: "RabbitMQ",
      kafka: "Kafka",
    };
    dependencies.push({
      service: candidate.name,
      kind,
      displayName: displayNames[kind],
      containerPort: ports.containerPort,
      hostPort: ports.hostPort,
      hasHealthcheck: /^\s+healthcheck\s*:/m.test(block),
    });
  }
  return dependencies;
}

export function parsePostgresCompose(contents: string, environment: NodeJS.ProcessEnv) {
  const dependency = parseComposeDependencies(contents, environment).find((item) => item.kind === "postgresql");
  return dependency?.hostPort ? { service: dependency.service, port: dependency.hostPort } : null;
}

export function mapDatasourceForHost(value: string, service: string, containerPort: number, hostPort: number) {
  const escapedService = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const authority = new RegExp(`((?:jdbc:)?(?:postgres(?:ql)?|mysql):\\/\\/(?:[^@/\\s]+@)?)${escapedService}(?::${containerPort})?`, "i");
  return authority.test(value) ? value.replace(authority, `$1localhost:${hostPort}`) : null;
}

export function redactRuntimeOutput(value: string, redactions: string[]) {
  let redacted = value.replace(/((?:jdbc:)?postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, "$1[REDACTED]@");
  for (const secret of redactions) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
}

export function classifySpringFailureOutput(output: string) {
  if (/JWT_SECRET must be at least 32 bytes/i.test(output)) return "JWT_SECRET is missing or does not meet the backend's local configuration requirement.";
  if (/(connection refused|could not connect)[\s\S]*?(postgres|localhost|127\.0\.0\.1)|org\.postgresql[\s\S]*connection[\s\S]*refused/i.test(output)) {
    return "PostgreSQL refused the backend connection. Confirm the configured local database is running.";
  }
  if (/address already in use|port .* already in use|failed to bind/i.test(output)) return "The backend could not bind its application port.";
  if (/mvnw.*(?:not recognized|not found)|maven.*(?:not found|could not be found)/i.test(output)) return "The Maven wrapper could not be started.";
  return null;
}

export function buildComposeCommandArgs(
  repositoryId: string,
  composePath: string,
  operation: "start" | "stop",
  services: string[],
) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(repositoryId) || services.length === 0 || services.some((service) => !/^[A-Za-z0-9_.-]+$/.test(service))) {
    throw new Error("Invalid trusted Compose operation metadata.");
  }
  const base = ["compose", "--project-name", `devhub-${repositoryId.toLowerCase()}`, "--file", composePath];
  return operation === "start"
    ? [...base, "up", "--detach", ...services]
    : [...base, "stop", ...services];
}
