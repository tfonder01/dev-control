import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  environmentRuntimeScope,
  environmentServiceOrder,
  parseWorkspaceEnvironmentConfig,
  parseWorkspaceEnvironmentConfigFile,
} from "../lib/projects/environment-config.ts";
import { resolveExternalEnvironmentFile, resolveRepositoryEnvironmentFile } from "../lib/projects/environment-file-resolution.ts";
import { buildComposeContainerStateArgs, buildExplicitComposeCommandArgs, classifyComposeContainerState, classifyComposePsIdentity, devHubComposeProjectName, devHubComposeVolumeName, devHubDependencyComposeProjectId, redactRuntimeOutput, summarizeRuntimeOutput } from "../lib/projects/runtime-config.ts";

function validWorkspace() {
  return {
    version: 1,
    id: "wealth-workspace",
    name: "Wealth Workspace",
    repositories: [
      { id: "web", repositoryId: "aaaaaaaaaaaaaaaa" },
      { id: "api", repositoryId: "bbbbbbbbbbbbbbbb" },
    ],
    externalEnvironmentFiles: [
      { id: "trial-api", pathVariable: "TRIAL_PRIVATE_ROOT", relativePath: "backend.env" },
    ],
    profiles: [{
      id: "sandbox",
      name: "Sandbox",
      risk: "local",
      exclusiveGroup: "wealth",
      loopbackOnly: true,
      openUrl: "http://localhost:3000",
      services: [
        {
          id: "api",
          name: "API",
          adapter: "spring-boot",
          repository: "api",
          serviceId: "cccccccccccccccc",
          dependsOn: ["database"],
          environment: {},
          port: 8080,
          host: "127.0.0.1",
          healthChecks: [{ type: "http", url: "http://127.0.0.1:8080/actuator/health", expectedStatuses: [200] }],
          environmentFiles: [],
        },
        {
          id: "database",
          name: "Database",
          adapter: "docker-compose",
          repository: "api",
          composeFile: "infrastructure/compose.yml",
          projectName: "wealth-sandbox",
          services: ["postgres"],
          dependsOn: [],
          environment: {},
          port: 5433,
          host: "127.0.0.1",
          healthChecks: [{ type: "docker-health", service: "postgres" }],
          environmentFiles: [],
        },
        {
          id: "web",
          name: "Web",
          adapter: "node",
          repository: "web",
          serviceId: "dddddddddddddddd",
          launchMode: "dev",
          dependsOn: ["api"],
          environment: {},
          port: 3000,
          host: "localhost",
          healthChecks: [{ type: "tcp", host: "127.0.0.1", port: 3000 }],
          environmentFiles: [],
        },
      ],
    }],
  };
}

test("strictly parses versioned multi-repository environment profiles", () => {
  const parsed = parseWorkspaceEnvironmentConfig(validWorkspace());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config.repositories.map((repository) => repository.id), ["web", "api"]);
  const order = environmentServiceOrder(parsed.config.profiles[0]);
  assert.equal(order.ok, true);
  if (order.ok) {
    assert.deepEqual(order.startup.map((service) => service.id), ["database", "api", "web"]);
    assert.deepEqual(order.shutdown.map((service) => service.id), ["web", "api", "database"]);
  }
  assert.equal(environmentRuntimeScope("wealth-workspace", "sandbox"), "wealth-workspace:sandbox");
});

test("rejects unknown properties, missing fixed ports, non-loopback checks, and embedded URL credentials", () => {
  const input = validWorkspace();
  Object.assign(input, { unexpected: true });
  input.profiles[0].services[0].port = null as unknown as number;
  input.profiles[0].services[0].healthChecks = [{ type: "http", url: "http://user:secret@example.com/health", expectedStatuses: [200] }];
  const parsed = parseWorkspaceEnvironmentConfig(input);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.issues.some((candidate) => candidate.path === "$.unexpected"));
  assert.ok(parsed.issues.some((candidate) => candidate.path.endsWith(".port") && candidate.message.includes("fixed port")));
  assert.ok(parsed.issues.some((candidate) => candidate.path.endsWith(".url") && candidate.message.includes("without embedded credentials")));
});

test("rejects dependency cycles and duplicate fixed ports deterministically", () => {
  const input = validWorkspace();
  input.profiles[0].services[1].dependsOn = ["web"];
  input.profiles[0].services[2].port = 8080;
  const parsed = parseWorkspaceEnvironmentConfig(input);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.issues.some((candidate) => candidate.message.includes("Dependency cycle detected")));
  assert.ok(parsed.issues.some((candidate) => candidate.message.includes("Conflicts with service api")));
});

test("rejects unknown repository and external environment references", () => {
  const input = validWorkspace();
  input.profiles[0].services[0].repository = "missing";
  input.profiles[0].services[0].environmentFiles = [{ source: "external", reference: "missing" }] as never[];
  const parsed = parseWorkspaceEnvironmentConfig(input);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.issues.some((candidate) => candidate.message === "Unknown repository reference missing."));
  assert.ok(parsed.issues.some((candidate) => candidate.message === "Unknown external environment reference missing."));
});

test("rejects secret-bearing trusted-process arguments", () => {
  const input = validWorkspace();
  input.profiles[0].services = [{
    id: "proxy",
    name: "Proxy",
    adapter: "process",
    repository: null,
    executable: "proxy.exe",
    args: ["--api-token=must-not-live-in-config"],
    workingDirectory: { externalPathVariable: "TRUSTED_ROOT" },
    stop: null,
    dependsOn: [],
    environment: {},
    environmentFiles: [],
    healthChecks: [{ type: "process" }],
    host: "127.0.0.1",
    port: 3443,
  }] as never[];
  const parsed = parseWorkspaceEnvironmentConfig(input);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.issues.some((candidate) => candidate.message.includes("Secret-bearing command arguments")));
});

test("allows fixed non-secret profile settings and rejects secret values in manifests", () => {
  const input = validWorkspace();
  input.profiles[0].services[0].environment = { PLAID_ENV: "sandbox" };
  assert.equal(parseWorkspaceEnvironmentConfig(input).ok, true);
  input.profiles[0].services[0].environment = { PLAID_SECRET: "must-not-be-stored" };
  const parsed = parseWorkspaceEnvironmentConfig(input);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.ok(parsed.issues.some((candidate) => candidate.message.includes("environment-file reference")));
});

test("tracked SentryWealth Sandbox manifest validates with deterministic dependency order", async () => {
  const manifest = JSON.parse(await readFile(path.resolve("config", "environment-profiles.json"), "utf8"));
  const parsed = parseWorkspaceEnvironmentConfigFile(manifest);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const workspace = parsed.config.workspaces.find((candidate) => candidate.id === "sentrywealth");
  assert.ok(workspace);
  const sandbox = workspace.profiles.find((candidate) => candidate.id === "sandbox");
  assert.ok(sandbox);
  const order = environmentServiceOrder(sandbox);
  assert.equal(order.ok, true);
  if (order.ok) assert.deepEqual(order.startup.map((service) => service.id), ["database", "backend", "frontend"]);
  assert.equal(sandbox.risk, "local");
  assert.equal(sandbox.loopbackOnly, true);
  assert.equal(sandbox.openUrl, "http://127.0.0.1:3002/");
  const database = sandbox.services.find((service) => service.id === "database");
  const backend = sandbox.services.find((service) => service.id === "backend");
  assert.equal(database?.adapter, "docker-compose");
  assert.equal(backend?.adapter, "spring-boot");
  if (database?.adapter === "docker-compose" && backend?.adapter === "spring-boot") {
    const legacyProjectId = devHubDependencyComposeProjectId("mbl4t3RoIqL2ePxO", backend.serviceId, "0ggyQhHWMYKxPSqW");
    assert.equal(database.projectName, devHubComposeProjectName(legacyProjectId));
    assert.equal(devHubComposeVolumeName(legacyProjectId, "postgres_data"), "devhub-sbzyspr8ueguv6vd_postgres_data");
    assert.notEqual(database.projectName, "infrastructure");
    assert.equal(database.composeFile, "infrastructure/docker-compose.yml");
    assert.deepEqual(database.services, ["postgres"]);
    assert.equal(database.host, "127.0.0.1");
    assert.equal(database.port, 5433);
  }
  const frontend = sandbox.services.find((service) => service.id === "frontend");
  assert.equal(frontend?.port, 3002);
  assert.equal(frontend?.adapter === "node" ? frontend.launchMode : null, "preview");
  assert.equal(frontend?.healthChecks[0]?.type, "http");
  if (frontend?.healthChecks[0]?.type === "http") assert.equal(frontend.healthChecks[0].url, "http://127.0.0.1:3002/");
  assert.equal(frontend?.environment.SENTRYWEALTH_API_URL, "http://127.0.0.1:8080");
  assert.equal(frontend?.environment.PORT, undefined);
  assert.equal(sandbox.services.find((service) => service.id === "backend")?.environment.PLAID_ENV, "sandbox");
  assert.equal(JSON.stringify(manifest).includes("PLAID_SECRET"), false);
});

test("tracked SentryWealth Production Trial preserves existing identities and the four-service safety chain", async () => {
  const manifest = JSON.parse(await readFile(path.resolve("config", "environment-profiles.json"), "utf8"));
  const parsed = parseWorkspaceEnvironmentConfigFile(manifest);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const workspace = parsed.config.workspaces.find((candidate) => candidate.id === "sentrywealth");
  assert.ok(workspace);
  const trial = workspace.profiles.find((candidate) => candidate.id === "production-trial");
  assert.ok(trial);
  assert.equal(trial.risk, "real-data");
  assert.equal(trial.exclusiveGroup, "sentrywealth-environment");
  assert.equal(trial.loopbackOnly, true);
  assert.equal(trial.openUrl, "https://localhost:3443/");

  const order = environmentServiceOrder(trial);
  assert.equal(order.ok, true);
  if (order.ok) {
    assert.deepEqual(order.startup.map((service) => service.id), ["trial-database", "trial-backend", "trial-frontend", "trial-caddy"]);
    assert.deepEqual(order.shutdown.map((service) => service.id), ["trial-caddy", "trial-frontend", "trial-backend", "trial-database"]);
  }

  const database = trial.services.find((service) => service.id === "trial-database");
  assert.equal(database?.adapter, "docker-compose");
  if (database?.adapter === "docker-compose") {
    assert.equal(database.projectName, "sentrywealth-production-trial");
    assert.equal(database.composeFile, "infrastructure/docker-compose.production-trial.yml");
    assert.deepEqual(database.services, ["postgres-trial"]);
    assert.equal(database.host, "127.0.0.1");
    assert.equal(database.port, 5434);
    assert.deepEqual(database.environmentFiles, [{ source: "external", reference: "production-trial-compose" }]);
  }

  const backend = trial.services.find((service) => service.id === "trial-backend");
  assert.equal(backend?.adapter === "spring-boot" ? backend.springProfile : null, "production-trial");
  assert.equal(backend?.port, 8180);
  assert.deepEqual(backend?.environment, {});

  const frontend = trial.services.find((service) => service.id === "trial-frontend");
  assert.equal(frontend?.adapter === "node" ? frontend.launchMode : null, "preview");
  assert.equal(frontend?.port, 3100);
  assert.equal(frontend?.environment.SENTRYWEALTH_API_URL, "http://127.0.0.1:8180");
  assert.equal(frontend?.environment.NEXT_PUBLIC_SENTRYWEALTH_ENVIRONMENT, "production-trial");
  assert.equal(frontend?.environment.NEXT_PUBLIC_SENTRYWEALTH_DISPLAY_TIME_ZONE, "America/New_York");
  assert.deepEqual(frontend?.environmentFiles, []);

  const caddy = trial.services.find((service) => service.id === "trial-caddy");
  assert.equal(caddy?.adapter, "process");
  if (caddy?.adapter === "process") {
    assert.equal(caddy.executable, "caddy.exe");
    assert.deepEqual(caddy.args, ["run", "--config", "Caddyfile"]);
    assert.deepEqual(caddy.stop, { executable: "caddy.exe", args: ["stop"] });
    assert.deepEqual(caddy.workingDirectory, { repository: "application", path: "infrastructure/production-trial" });
    assert.equal(caddy.port, 3443);
    assert.equal(caddy.healthChecks[0]?.type, "http");
    if (caddy.healthChecks[0]?.type === "http") {
      assert.equal(caddy.healthChecks[0].url, "https://localhost:3443/");
      assert.equal(caddy.healthChecks[0].allowInvalidCertificate, false);
      assert.equal(caddy.healthChecks[0].trustStore, "system");
    }
  }

  assert.deepEqual(workspace.externalEnvironmentFiles.map((reference) => reference.pathVariable), [
    "DEVHUB_SENTRYWEALTH_TRIAL_DB_ENV_FILE",
    "DEVHUB_SENTRYWEALTH_TRIAL_BACKEND_ENV_FILE",
  ]);
  assert.equal(JSON.stringify(trial).includes("PLAID_ENABLED"), false);
  assert.equal(JSON.stringify(trial).includes("PLAID_PRODUCTION_TRIAL_ACKNOWLEDGED"), false);

  const compose = await readFile(path.resolve("..", "SentryWealth", "infrastructure", "docker-compose.production-trial.yml"), "utf8");
  assert.match(compose, /^name:\s*sentrywealth-production-trial\s*$/m);
  assert.match(compose, /^\s{2}postgres-trial:\s*$/m);
  assert.match(compose, /^\s{4}name:\s*sentrywealth_production_trial_data\s*$/m);

  const caddyfile = await readFile(path.resolve("..", "SentryWealth", "infrastructure", "production-trial", "Caddyfile"), "utf8");
  assert.match(caddyfile, /skip_install_trust/);
  assert.match(caddyfile, /https:\/\/localhost:3443/);
  assert.match(caddyfile, /bind\s+127\.0\.0\.1/);
  assert.match(caddyfile, /reverse_proxy\s+127\.0\.0\.1:3100/);
});

test("HTTP health checks accept only strict default or system trust stores", () => {
  const input = validWorkspace();
  input.profiles[0].services[0].healthChecks = [{
    type: "http",
    url: "https://localhost:3443",
    expectedStatuses: [200],
    allowInvalidCertificate: false,
    trustStore: "system",
  }] as never[];
  const parsed = parseWorkspaceEnvironmentConfig(input);
  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.config.profiles[0].services[0].healthChecks[0].type === "http") {
    assert.equal(parsed.config.profiles[0].services[0].healthChecks[0].trustStore, "system");
  }
  input.profiles[0].services[0].healthChecks[0] = {
    type: "http",
    url: "https://localhost:3443",
    expectedStatuses: [200],
    allowInvalidCertificate: false,
    trustStore: "insecure",
  } as never;
  const rejected = parseWorkspaceEnvironmentConfig(input);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.ok(rejected.issues.some((candidate) => candidate.path.endsWith(".trustStore")));
});

test("strictly validates the top-level environment configuration file", () => {
  const parsed = parseWorkspaceEnvironmentConfigFile({ version: 1, workspaces: [validWorkspace()] });
  assert.equal(parsed.ok, true);
  const invalid = parseWorkspaceEnvironmentConfigFile({ version: 1, workspaces: [validWorkspace()], secret: "must-not-pass" });
  assert.equal(invalid.ok, false);
});

test("external and repository environment references stay inside their trusted roots", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-env-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  const privateRoot = path.join(root, "private");
  await mkdir(repository);
  await mkdir(privateRoot);
  await writeFile(path.join(repository, "local.env"), "LOCAL_VALUE=placeholder\n");
  await writeFile(path.join(privateRoot, "owner.env"), "PRIVATE_VALUE=placeholder\n");
  await writeFile(path.join(root, "outside.env"), "OUTSIDE=placeholder\n");

  assert.equal(await resolveRepositoryEnvironmentFile(repository, "local.env"), path.join(repository, "local.env"));
  const ownerEnvironment = { NODE_ENV: "test", PRIVATE_ROOT: privateRoot } as NodeJS.ProcessEnv;
  assert.equal(await resolveExternalEnvironmentFile("PRIVATE_ROOT", "owner.env", ownerEnvironment), path.join(privateRoot, "owner.env"));
  await assert.rejects(resolveRepositoryEnvironmentFile(repository, "../outside.env"));
  await assert.rejects(resolveExternalEnvironmentFile("PRIVATE_ROOT", "../outside.env", ownerEnvironment));
  await assert.rejects(resolveExternalEnvironmentFile("PRIVATE_ROOT", null, { NODE_ENV: "test", PRIVATE_ROOT: "relative/path" } as NodeJS.ProcessEnv));
});

test("explicit Compose commands preserve project and service identity without destructive operations", () => {
  const composePath = path.resolve("fixtures", "compose.yml");
  assert.deepEqual(buildExplicitComposeCommandArgs("wealth-trial", composePath, "start", ["postgres-trial"]), [
    "compose", "--project-name", "wealth-trial", "--file", composePath, "up", "--detach", "postgres-trial",
  ]);
  assert.deepEqual(buildExplicitComposeCommandArgs("wealth-trial", composePath, "stop", ["postgres-trial"]), [
    "compose", "--project-name", "wealth-trial", "--file", composePath, "stop", "--timeout", "10", "postgres-trial",
  ]);
  const privateEnvironment = path.resolve("fixtures", "trial.env");
  assert.deepEqual(buildExplicitComposeCommandArgs("wealth-trial", composePath, "status", ["postgres-trial"], [privateEnvironment]), [
    "compose", "--env-file", privateEnvironment, "--project-name", "wealth-trial", "--file", composePath, "ps", "--format", "json", "postgres-trial",
  ]);
  assert.throws(() => buildExplicitComposeCommandArgs("bad project", composePath, "start", ["postgres"]));
  assert.throws(() => buildExplicitComposeCommandArgs("wealth-trial", composePath, "status", ["postgres-trial"], ["relative.env"]));
  assert.deepEqual(buildComposeContainerStateArgs("wealth-trial"), [
    "container", "ls", "--all", "--filter", "label=com.docker.compose.project=wealth-trial", "--format", "{{json .}}",
  ]);
  assert.throws(() => buildComposeContainerStateArgs("bad project"));
});

test("stopped Compose containers remain stopped without loading launch environment files", () => {
  const labels = "com.docker.compose.project=wealth-trial,com.docker.compose.service=postgres-trial";
  const exited = JSON.stringify({ Labels: labels, State: "exited", Status: "Exited (0) 16 hours ago" });
  assert.equal(classifyComposeContainerState(exited, "wealth-trial", ["postgres-trial"]).state, "stopped");
  assert.equal(classifyComposeContainerState("", "wealth-trial", ["postgres-trial"]).state, "stopped");
  const running = JSON.stringify({ Labels: labels, State: "running", Status: "Up 10 seconds" });
  assert.equal(classifyComposeContainerState(running, "wealth-trial", ["postgres-trial"]).state, "active-or-unverifiable");
  const unknown = JSON.stringify({ Labels: labels, State: "removing" });
  assert.equal(classifyComposeContainerState(unknown, "wealth-trial", ["postgres-trial"]).state, "active-or-unverifiable");
  assert.equal(classifyComposeContainerState("not-json", "wealth-trial", ["postgres-trial"]).state, "active-or-unverifiable");
});

test("Compose status requires the configured project, services, fixed port, and loopback publisher", () => {
  const healthy = JSON.stringify([{
    Service: "postgres-trial",
    Project: "wealth-trial",
    State: "running",
    Health: "healthy",
    Publishers: [{ URL: "127.0.0.1", PublishedPort: 5434, TargetPort: 5432, Protocol: "tcp" }],
  }]);
  assert.equal(classifyComposePsIdentity(healthy, "wealth-trial", ["postgres-trial"], "127.0.0.1", 5434).state, "healthy");
  const unhealthy = healthy.replace('"Health":"healthy"', '"Health":"unhealthy"');
  assert.equal(classifyComposePsIdentity(unhealthy, "wealth-trial", ["postgres-trial"], "127.0.0.1", 5434).state, "running");
  assert.equal(classifyComposePsIdentity(healthy, "other-project", ["postgres-trial"], "127.0.0.1", 5434).reason, "project");
  assert.equal(classifyComposePsIdentity(healthy, "wealth-trial", ["postgres-trial"], "127.0.0.1", 5433).reason, "missing-publisher");
  const unpublished = healthy.replace('"URL":"127.0.0.1","PublishedPort":5434', '"URL":"","PublishedPort":0');
  assert.equal(classifyComposePsIdentity(unpublished, "wealth-trial", ["postgres-trial"], "127.0.0.1", 5434).reason, "missing-publisher");
  const publicBind = healthy.replace("127.0.0.1", "0.0.0.0");
  assert.equal(classifyComposePsIdentity(publicBind, "wealth-trial", ["postgres-trial"], "127.0.0.1", 5434).reason, "non-loopback-publisher");
});

test("secret values are redacted without exposing command or environment contents", () => {
  const secret = "owner-only-secret-value";
  const output = redactRuntimeOutput(`startup failed with ${secret} and postgresql://user:password@localhost/db`, [secret]);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("password"), false);
  assert.match(output, /\[REDACTED\]/);
  assert.equal(
    summarizeRuntimeOutput(`failed with ${secret}\nport 5433 could not be published`, [secret]),
    "failed with [REDACTED] port 5433 could not be published",
  );
});
