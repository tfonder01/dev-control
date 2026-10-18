import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBoundedRuntimeEnvironment, createNodeProcessEnvironment } from "../lib/projects/runtime-environment.ts";

import {
  buildComposeCommandArgs,
  classifyComposePsIdentity,
  composeRowsUseConfigFile,
  classifySpringFailureOutput,
  databaseEndpoint,
  devHubComposeProjectName,
  devHubComposeVolumeName,
  devHubDependencyComposeProjectId,
  extractRequiredEnvironment,
  isSafeRepoRelativePath,
  isSensitiveEnvironmentName,
  isNodeProfileSelector,
  normalizeSpringProfile,
  parseDevHubConfig,
  parseComposeDependencies,
  parseEnvFile,
  parsePostgresCompose,
  parseYamlScalars,
  redactRuntimeOutput,
  resolvePlaceholders,
  mapDatasourceForHost,
  safeProfileState,
} from "../lib/projects/runtime-config.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

test("parses dotenv syntax without exposing comments as values", () => {
  assert.deepEqual(parseEnvFile([
    "# local values",
    "JWT_SECRET=first",
    "export DATABASE_URL='jdbc:postgresql://localhost:5433/app'",
    "JWT_SECRET=second # later entries win",
    "EMPTY=",
  ].join("\n")), {
    JWT_SECRET: "second",
    DATABASE_URL: "jdbc:postgresql://localhost:5433/app",
    EMPTY: "",
  });
});

test("parses the documented secret-free devhub runtime schema", () => {
  assert.deepEqual(parseDevHubConfig([
    "development:",
    "  type: spring-boot",
    "  envFile: .env.development",
    "  port: 8090",
    "  springProfile: dev",
    "prerequisites:",
    "  dockerCompose: false",
    "  requiredEnv:",
    "    - JWT_SECRET",
    "  ports:",
    "    - 5432",
  ].join("\n")), {
    envFile: ".env.development",
    port: 8090,
    springProfile: "dev",
    requiredEnv: ["JWT_SECRET"],
    prerequisitePorts: [5432],
    dockerCompose: false,
  });
});

test("accepts only a single safe Spring profile name", () => {
  assert.equal(normalizeSpringProfile("dev"), "dev");
  assert.equal(normalizeSpringProfile("local-seed_2"), "local-seed_2");
  assert.equal(normalizeSpringProfile("dev -Dspring.datasource.password=unsafe"), null);
  assert.equal(normalizeSpringProfile("dev,prod"), null);
});

test("keeps configured env file paths inside the repository", () => {
  assert.equal(isSafeRepoRelativePath(".env.local"), true);
  assert.equal(isSafeRepoRelativePath("config/local.env"), true);
  assert.equal(isSafeRepoRelativePath("../shared.env"), false);
  assert.equal(isSafeRepoRelativePath("C:\\secrets.env"), false);
});

test("infers only placeholders without defaults as required", () => {
  assert.deepEqual(extractRequiredEnvironment("secret: ${JWT_SECRET}\nurl: ${DATABASE_URL:jdbc:postgresql://localhost:5432/app}"), ["JWT_SECRET"]);
});

test("resolves Spring YAML datasource metadata and local PostgreSQL endpoints", () => {
  const yaml = parseYamlScalars("spring:\n  datasource:\n    url: ${DATABASE_URL:jdbc:postgresql://localhost:5432/app}\n");
  const value = resolvePlaceholders(yaml["spring.datasource.url"], {} as NodeJS.ProcessEnv);
  assert.deepEqual(databaseEndpoint(value), { type: "postgresql", host: "localhost", port: 5432, local: true });
  assert.deepEqual(databaseEndpoint("postgresql://db.internal/app"), { type: "postgresql", host: "db.internal", port: 5432, local: false });
});

test("recognizes secret-bearing environment names for output redaction", () => {
  assert.equal(isSensitiveEnvironmentName("JWT_SECRET"), true);
  assert.equal(isSensitiveEnvironmentName("DATABASE_PASSWORD"), true);
  assert.equal(isSensitiveEnvironmentName("APP_PORT"), false);
});

test("recognizes launch profile selectors and exposes only normalized states", () => {
  assert.equal(isNodeProfileSelector("NEXT_PUBLIC_APP_MODE"), true);
  assert.equal(isNodeProfileSelector("DEMO_MODE"), true);
  assert.equal(isNodeProfileSelector("NEXT_PUBLIC_USE_MOCK_DATA"), true);
  assert.equal(isNodeProfileSelector("API_SECRET"), false);
  assert.equal(safeProfileState("NEXT_PUBLIC_APP_MODE", "production"), "Production");
  assert.equal(safeProfileState("DEMO_MODE", "false"), "Disabled");
  assert.equal(safeProfileState("NEXT_PUBLIC_USE_MOCK_DATA", "true"), "Demo");
  assert.equal(safeProfileState("NEXT_PUBLIC_APP_MODE", "tenant-secret-value"), "Custom");
});

test("launched Next.js runtimes prefer repository env while retaining DevHub's port", async (context) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "devhub-next-env-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(path.join(fixture, ".env.local"), [
    "LEAD_SCOUT_PROVIDER=google",
    "GOOGLE_PLACES_API_KEY=test-placeholder-only",
  ].join("\n"));

  const environment = createBoundedRuntimeEnvironment({
    ...process.env,
    LEAD_SCOUT_PROVIDER: "mock",
    GOOGLE_PLACES_API_KEY: "parent-placeholder-only",
    DEV_CONTROL_ROOT: "C:\\workspace",
  }, {
    NODE_ENV: "development",
    PORT: "4317",
  });
  assert.equal(environment.LEAD_SCOUT_PROVIDER, undefined);
  assert.equal(environment.GOOGLE_PLACES_API_KEY, undefined);
  assert.equal(environment.DEV_CONTROL_ROOT, undefined);
  for (const requiredName of ["PATH", "SYSTEMROOT", "COMSPEC", "TEMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    const inheritedName = Object.keys(process.env).find((name) => name.toUpperCase() === requiredName);
    if (inheritedName) assert.equal(environment[inheritedName], process.env[inheritedName]);
  }

  const nextEnvironmentModule = require.resolve("@next/env", { paths: [require.resolve("next")] });
  const script = [
    "const { loadEnvConfig } = require(process.argv[1]);",
    "loadEnvConfig(process.cwd(), true);",
    "process.stdout.write(JSON.stringify({ provider: process.env.LEAD_SCOUT_PROVIDER, port: process.env.PORT }));",
  ].join(" ");
  const { stdout } = await execFileAsync(process.execPath, ["-e", script, nextEnvironmentModule], {
    cwd: fixture,
    env: environment,
    encoding: "utf8",
  });

  assert.deepEqual(JSON.parse(stdout), { provider: "google", port: "4317" });
});

test("Preview build and start environments retain profile API settings and fixed mode bindings", () => {
  const runtime = { NODE_ENV: "production", PATH: "C:\\tools" } as NodeJS.ProcessEnv;
  const profile = {
    NODE_ENV: "development",
    SENTRYWEALTH_API_URL: "http://127.0.0.1:8080",
    NEXT_PUBLIC_SENTRYWEALTH_ENVIRONMENT: "sandbox",
  } as NodeJS.ProcessEnv;
  const build = createNodeProcessEnvironment(runtime, profile);
  const start = createNodeProcessEnvironment(runtime, profile, { host: "127.0.0.1", port: 3002 });

  for (const environment of [build, start]) {
    assert.equal(environment.NODE_ENV, "production");
    assert.equal(environment.SENTRYWEALTH_API_URL, "http://127.0.0.1:8080");
    assert.equal(environment.NEXT_PUBLIC_SENTRYWEALTH_ENVIRONMENT, "sandbox");
  }
  assert.equal(build.PORT, undefined);
  assert.equal(start.PORT, "3002");
  assert.equal(start.HOSTNAME, "127.0.0.1");
});

test("detects a PostgreSQL Compose service and its host port without reading secrets", () => {
  const compose = [
    "services:",
    "  postgres:",
    "    image: postgres:16",
    "    environment:",
    "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}",
    "    ports:",
    "      - \"${POSTGRES_PORT:-5433}:5432\"",
    "  backend:",
    "    image: app",
  ].join("\n");
  assert.deepEqual(parsePostgresCompose(compose, {} as NodeJS.ProcessEnv), { service: "postgres", port: 5433 });
  assert.deepEqual(parseComposeDependencies(compose, {} as NodeJS.ProcessEnv), [{
    service: "postgres",
    kind: "postgresql",
    displayName: "PostgreSQL",
    containerPort: 5432,
    hostPort: 5433,
    hasHealthcheck: false,
  }]);
});

test("excludes application services and detects other allowlisted dependency images", () => {
  const compose = [
    "services:",
    "  redis:",
    "    image: redis:7-alpine",
    "    ports:",
    "      - \"6380:6379\"",
    "  backend:",
    "    build: .",
    "    environment:",
    "      DATABASE_URL: jdbc:postgresql://postgres:5432/app",
  ].join("\n");
  assert.deepEqual(parseComposeDependencies(compose, {} as NodeJS.ProcessEnv).map((item) => item.service), ["redis"]);
});

test("maps a Compose datasource host for Maven without changing credentials, database, or query", () => {
  assert.equal(
    mapDatasourceForHost("jdbc:postgresql://user:password@postgres:5432/app?sslmode=disable", "postgres", 5432, 5544),
    "jdbc:postgresql://user:password@localhost:5544/app?sslmode=disable",
  );
  assert.equal(mapDatasourceForHost("jdbc:postgresql://remote:5432/app", "postgres", 5432, 5544), null);
});

test("redacts injected secrets and database URL credentials from recent output", () => {
  const output = "JWT=local-secret jdbc:postgresql://app:db-password@localhost:5432/app";
  const redacted = redactRuntimeOutput(output, ["local-secret"]);
  assert.equal(redacted.includes("local-secret"), false);
  assert.equal(redacted.includes("db-password"), false);
  assert.equal(redacted, "JWT=[REDACTED] jdbc:postgresql://app:[REDACTED]@localhost:5432/app");
});

test("classifies useful Spring startup failures before the generic exit message", () => {
  assert.match(classifySpringFailureOutput("JWT_SECRET must be at least 32 bytes") ?? "", /JWT_SECRET/);
  assert.match(classifySpringFailureOutput("org.postgresql: connection refused") ?? "", /PostgreSQL/);
  assert.match(classifySpringFailureOutput("Address already in use") ?? "", /application port/);
});

test("builds only targeted, repository-scoped Compose lifecycle commands", () => {
  assert.deepEqual(buildComposeCommandArgs("RB24Abqiy8Q5H8dC", "C:\\repo\\compose.yml", "start", ["postgres"]), [
    "compose", "--project-name", "devhub-rb24abqiy8q5h8dc", "--file", "C:\\repo\\compose.yml", "up", "--detach", "postgres",
  ]);
  const stop = buildComposeCommandArgs("RB24Abqiy8Q5H8dC", "C:\\repo\\compose.yml", "stop", ["postgres"]);
  assert.deepEqual(stop.slice(-2), ["stop", "postgres"]);
  assert.equal(stop.includes("down"), false);
  assert.equal(stop.includes("--volumes"), false);
  assert.deepEqual(buildComposeCommandArgs("RB24Abqiy8Q5H8dC", "C:\\repo\\compose.yml", "status", ["postgres"]), [
    "compose", "--project-name", "devhub-rb24abqiy8q5h8dc", "--file", "C:\\repo\\compose.yml", "ps", "--all", "--format", "json", "postgres",
  ]);
  assert.throws(() => buildComposeCommandArgs("RB24Abqiy8Q5H8dC", "C:\\repo\\compose.yml", "start", ["postgres;backend"]));
  assert.throws(() => buildComposeCommandArgs("RB24Abqiy8Q5H8dC", "C:\\repo\\compose.yml", "start", []));
});

test("legacy dependency identity preserves the original Compose project and named-volume namespace", () => {
  const repositoryId = "mbl4t3RoIqL2ePxO";
  const projectId = devHubDependencyComposeProjectId(repositoryId, "5uwmxJzD4rY1MF2Z", "0ggyQhHWMYKxPSqW");
  const project = devHubComposeProjectName(projectId);
  assert.equal(project, "devhub-sbzyspr8ueguv6vd");
  assert.equal(devHubComposeVolumeName(projectId, "postgres_data"), "devhub-sbzyspr8ueguv6vd_postgres_data");

  const matching = JSON.stringify([{
    Service: "postgres",
    Project: project,
    State: "running",
    Health: "healthy",
    Labels: "com.docker.compose.project=devhub-sbzyspr8ueguv6vd,com.docker.compose.project.config_files=C:\\repo\\infrastructure\\docker-compose.yml",
    Publishers: [{ URL: "127.0.0.1", PublishedPort: 5433, TargetPort: 5432, Protocol: "tcp" }],
  }]);
  assert.equal(classifyComposePsIdentity(matching, project, ["postgres"], "127.0.0.1", 5433).state, "healthy");
  assert.equal(classifyComposePsIdentity(matching, "infrastructure", ["postgres"], "127.0.0.1", 5433).reason, "project");
  const rows = classifyComposePsIdentity(matching, project, ["postgres"], "127.0.0.1", 5433).rows;
  assert.equal(composeRowsUseConfigFile(rows, "C:\\repo\\infrastructure\\docker-compose.yml"), true);
  assert.equal(composeRowsUseConfigFile(rows, "C:\\repo\\compose.yml"), false);

  const stopped = matching.replace('"State":"running"', '"State":"exited"');
  assert.equal(classifyComposePsIdentity(stopped, project, ["postgres"], "127.0.0.1", 5433).state, "stopped");
});
