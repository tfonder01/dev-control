import assert from "node:assert/strict";
import test from "node:test";

import type { EnvironmentProfile, EnvironmentService, WorkspaceEnvironmentConfig } from "../lib/projects/environment-config.ts";
import type { Repository } from "../lib/workspace/types.ts";
import {
  EnvironmentOrchestrator,
  runEnvironmentHealthChecks,
  strictHttpsHealthOptions,
  type EnvironmentAdapterContext,
  type EnvironmentAdapterRegistry,
  type EnvironmentRuntimeAdapter,
  type EnvironmentServiceObservation,
} from "../lib/projects/environment-orchestrator.ts";

test("system-trust HTTPS checks retain strict certificate validation", () => {
  const options = strictHttpsHealthOptions("system");
  assert.equal(options.rejectUnauthorized, true);
  assert.ok(Array.isArray(options.ca));
  assert.ok(options.ca.length > 0);
  assert.deepEqual(strictHttpsHealthOptions("default"), { rejectUnauthorized: true });
});

function processService(id: string, port: number, dependsOn: string[] = []): EnvironmentService {
  return {
    id,
    name: id,
    adapter: "process",
    repository: null,
    executable: "trusted.exe",
    args: [],
    workingDirectory: { externalPathVariable: "TRUSTED_ROOT" },
    stop: null,
    dependsOn,
    environment: {},
    environmentFiles: [],
    healthChecks: [{ type: "process", timeoutMs: 1_000 }],
    host: "127.0.0.1",
    port,
  };
}

function nodeService(launchMode: "dev" | "preview", dependsOn: string[] = []): EnvironmentService {
  return {
    id: "frontend",
    name: "Frontend",
    adapter: "node",
    repository: "application",
    serviceId: "ffffffffffffffff",
    launchMode,
    dependsOn,
    environment: {},
    environmentFiles: [],
    healthChecks: [{ type: "process", timeoutMs: 1_000 }],
    host: "127.0.0.1",
    port: 3002,
  };
}

function nodeRepository(): Repository {
  return {
    id: "aaaaaaaaaaaaaaaa",
    name: "Application",
    path: "C:\\application",
    relativePath: "application",
    technologies: [],
    configurationFiles: [],
    infrastructure: [],
    services: [{
      id: "ffffffffffffffff",
      name: "frontend",
      path: "C:\\application\\frontend",
      relativePath: "frontend",
      kind: "node",
      technologies: [{ name: "Next.js", tone: "slate" }],
      configurationFiles: [],
      commands: [],
      capabilities: {
        packageManager: "pnpm",
        packageScripts: ["dev", "build", "start"],
        hasMavenWrapper: false,
        hasGradleWrapper: false,
        hasSpringBoot: false,
        javaBuildTool: null,
        devPortHint: 3000,
        devPortSource: "framework-default",
      },
    }],
    git: {} as Repository["git"],
  };
}

function profile(id: string, services: EnvironmentService[], exclusiveGroup = "application"): EnvironmentProfile {
  return { id, name: id, risk: "local", exclusiveGroup, loopbackOnly: true, openUrl: null, services };
}

function config(profiles: EnvironmentProfile[]): WorkspaceEnvironmentConfig {
  return { version: 1, id: "test-workspace", name: "Test", repositories: [], externalEnvironmentFiles: [], profiles };
}

function nodeConfig(services: EnvironmentService[]) {
  return {
    ...config([profile("sandbox", services)]),
    repositories: [{ id: "application", repositoryId: "aaaaaaaaaaaaaaaa" }],
  };
}

function observation(state: EnvironmentServiceObservation["state"], ownership: EnvironmentServiceObservation["ownership"]): EnvironmentServiceObservation {
  return { state, ownership, message: state, port: null, url: null };
}

function harness(workspace: WorkspaceEnvironmentConfig, setup?: (adapter: MockAdapter) => void, repositories: Repository[] = []) {
  const adapter = new MockAdapter();
  setup?.(adapter);
  const adapters = { node: adapter, "spring-boot": adapter, "docker-compose": adapter, process: adapter } satisfies EnvironmentAdapterRegistry;
  const files = {
    inspect: async () => [],
    load: async () => ({ environment: {} as NodeJS.ProcessEnv, redactions: [], sources: [] }),
  };
  const healthCalls: string[] = [];
  const health = async (_checks: unknown, current: EnvironmentServiceObservation, _adapter: EnvironmentRuntimeAdapter, context: EnvironmentAdapterContext) => {
    healthCalls.push(context.service.id);
    return { healthy: current.state !== "degraded", message: "healthy" };
  };
  return { adapter, healthCalls, orchestrator: new EnvironmentOrchestrator(workspace, repositories, adapters, files, health) };
}

class MockAdapter implements EnvironmentRuntimeAdapter {
  states = new Map<string, EnvironmentServiceObservation>();
  calls: string[] = [];
  failStart = new Set<string>();
  startFailures = new Map<string, string>();
  failStop = new Set<string>();
  startObservations = new Map<string, EnvironmentServiceObservation>();
  startBarrier: Promise<void> | null = null;
  probeResults: { healthy: boolean; message: string }[] = [];
  probeCalls = 0;
  inspectCalls = 0;
  startModes: ("dev" | "preview" | null)[] = [];
  startPorts: (number | null)[] = [];

  key(context: EnvironmentAdapterContext) {
    return `${context.runtimeScope}:${context.service.id}`;
  }

  async preflight() { return []; }

  async inspect(context: EnvironmentAdapterContext) {
    this.inspectCalls += 1;
    return this.states.get(this.key(context)) ?? observation("stopped", "none");
  }

  async start(context: EnvironmentAdapterContext) {
    this.calls.push(`start:${context.profile.id}:${context.service.id}`);
    this.startModes.push(context.service.adapter === "node" ? context.service.launchMode : null);
    this.startPorts.push(context.service.port);
    if (this.startBarrier) await this.startBarrier;
    const failure = this.startFailures.get(context.service.id);
    if (failure) throw new Error(failure);
    if (this.failStart.has(context.service.id)) throw new Error(`${context.service.id} failed safely`);
    const next = this.startObservations.get(context.service.id) ?? {
      ...observation("started", "devhub"),
      launchMode: context.service.adapter === "node" ? context.service.launchMode : null,
    };
    this.states.set(this.key(context), next);
    return next;
  }

  async stop(context: EnvironmentAdapterContext, options: { graceful: true }) {
    assert.equal(options.graceful, true);
    this.calls.push(`stop:${context.profile.id}:${context.service.id}`);
    if (this.failStop.has(context.service.id)) throw new Error("graceful stop failed");
    const next = observation("stopped", "none");
    this.states.set(this.key(context), next);
    return next;
  }

  async probe() {
    this.probeCalls += 1;
    return this.probeResults.shift() ?? { healthy: false, message: "postgres is still starting." };
  }
}

test("starts in dependency order and stops in deterministic reverse order", async () => {
  const { adapter, orchestrator } = harness(config([profile("sandbox", [
    processService("web", 3000, ["api"]),
    processService("database", 5433),
    processService("api", 8080, ["database"]),
  ])]));
  const started = await orchestrator.start("sandbox");
  assert.equal(started.status, "success");
  assert.deepEqual(adapter.calls, ["start:sandbox:database", "start:sandbox:api", "start:sandbox:web"]);
  const stopped = await orchestrator.stop("sandbox");
  assert.equal(stopped.status, "success");
  assert.deepEqual(adapter.calls.slice(3), ["stop:sandbox:web", "stop:sandbox:api", "stop:sandbox:database"]);
});

test("waits for Docker health readiness instead of failing the first starting probe", async () => {
  const adapter = new MockAdapter();
  adapter.probeResults.push(
    { healthy: false, message: "postgres is running and its Docker health check is still starting." },
    { healthy: false, message: "postgres is running and its Docker health check is still starting." },
    { healthy: true, message: "postgres is healthy." },
  );
  const context = {
    config: config([]),
    profile: profile("sandbox", []),
    service: processService("database", 5433),
    repositories: [],
    runtimeScope: "test-workspace:sandbox",
    environment: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    redactions: [],
    sources: [],
  } satisfies EnvironmentAdapterContext;

  const result = await runEnvironmentHealthChecks(
    [{ type: "docker-health", service: "postgres", timeoutMs: 1_000 }],
    observation("started", "devhub"),
    adapter,
    context,
  );

  assert.equal(result.healthy, true);
  assert.equal(result.message, "All configured health checks passed.");
  assert.equal(adapter.probeCalls, 3);
});

test("stops TCP readiness polling as soon as the managed process exit is observed", async () => {
  const adapter = new MockAdapter();
  const service = processService("backend", 8080);
  const context = {
    config: config([]),
    profile: profile("sandbox", []),
    service,
    repositories: [],
    runtimeScope: "test-workspace:sandbox",
    environment: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    redactions: [],
    sources: [],
  } satisfies EnvironmentAdapterContext;
  adapter.states.set(adapter.key(context), {
    ...observation("stopped", "none"),
    historicalFailure: {
      message: "Flyway validation failed before the backend became ready.",
      exitCode: 0,
      failedAt: "2026-10-20T15:54:18.000Z",
    },
  });

  const result = await runEnvironmentHealthChecks(
    [{ type: "tcp", host: "127.0.0.1", port: 8080, timeoutMs: 5_000 }],
    observation("started", "devhub"),
    adapter,
    context,
  );

  assert.equal(result.healthy, false);
  assert.match(result.message, /Flyway validation failed/);
  assert.equal(adapter.inspectCalls, 1);
});

test("rejects TCP readiness when the current listener ownership is unverifiable", async () => {
  const adapter = new MockAdapter();
  const service = processService("backend", 8080);
  const context = {
    config: config([]),
    profile: profile("sandbox", []),
    service,
    repositories: [],
    runtimeScope: "test-workspace:sandbox",
    environment: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    redactions: [],
    sources: [],
  } satisfies EnvironmentAdapterContext;
  adapter.states.set(adapter.key(context), {
    ...observation("degraded", "devhub"),
    message: "DevHub could not verify ownership of the current listener.",
  });

  const result = await runEnvironmentHealthChecks(
    [{ type: "tcp", host: "127.0.0.1", port: 8080, timeoutMs: 5_000 }],
    observation("started", "devhub"),
    adapter,
    context,
  );

  assert.equal(result.healthy, false);
  assert.match(result.message, /could not verify ownership/);
  assert.equal(adapter.inspectCalls, 1);
});

test("restart performs a complete reverse stop before dependency-ordered start", async () => {
  const workspace = config([profile("sandbox", [processService("database", 5433), processService("api", 8080, ["database"])])]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:sandbox:database", observation("healthy", "devhub"));
  adapter.states.set("test-workspace:sandbox:api", observation("healthy", "devhub"));
  const result = await orchestrator.restart("sandbox");
  assert.equal(result.status, "success");
  assert.deepEqual(adapter.calls, [
    "stop:sandbox:api", "stop:sandbox:database", "start:sandbox:database", "start:sandbox:api",
  ]);
});

test("applies Development and Preview modes to the same fixed frontend port", async () => {
  const { adapter, orchestrator } = harness(nodeConfig([nodeService("preview")]), undefined, [nodeRepository()]);

  const development = await orchestrator.start("sandbox", { launchModes: { frontend: "dev" } });
  assert.equal(development.status, "success");
  assert.equal(development.services[0].launchMode, "dev");
  await orchestrator.stop("sandbox");
  const preview = await orchestrator.start("sandbox");

  assert.equal(preview.status, "success");
  assert.equal(preview.services[0].launchMode, "preview");
  assert.deepEqual(adapter.startModes, ["dev", "preview"]);
  assert.deepEqual(adapter.startPorts, [3002, 3002]);
});

test("requires a controlled restart before changing a running frontend mode", async () => {
  const { adapter, orchestrator } = harness(nodeConfig([nodeService("dev")]), undefined, [nodeRepository()]);
  assert.equal((await orchestrator.start("sandbox")).status, "success");

  const unsafeStart = await orchestrator.start("sandbox", { launchModes: { frontend: "preview" } });
  assert.equal(unsafeStart.status, "error");
  assert.match(unsafeStart.message, /Restart Environment to apply Preview mode/);
  assert.equal(adapter.calls.filter((call) => call.startsWith("start:")).length, 1);

  const restarted = await orchestrator.restart("sandbox", { launchModes: { frontend: "preview" } });
  assert.equal(restarted.status, "success");
  assert.deepEqual(adapter.calls, [
    "start:sandbox:frontend",
    "stop:sandbox:frontend",
    "start:sandbox:frontend",
  ]);
  assert.deepEqual(adapter.startModes, ["dev", "preview"]);
});

test("reports a Preview build failure and rolls back only earlier owned services", async () => {
  const workspace = nodeConfig([processService("backend", 8080), nodeService("preview", ["backend"])]);
  const { adapter, orchestrator } = harness(workspace, (mock) => {
    mock.startFailures.set("frontend", "Production build failed (exit 1).");
  }, [nodeRepository()]);

  const result = await orchestrator.start("sandbox");
  assert.equal(result.status, "error");
  assert.match(result.message, /Production build failed/);
  assert.deepEqual(result.startedServiceIds, ["backend"]);
  assert.deepEqual(result.rolledBackServiceIds, ["backend"]);
  assert.deepEqual(adapter.calls, [
    "start:sandbox:backend",
    "start:sandbox:frontend",
    "stop:sandbox:backend",
  ]);
});

test("fails immediately when Spring exits before readiness, rolls back earlier resources, and permits retry", async () => {
  const workspace = config([profile("sandbox", [
    processService("database", 5433),
    processService("backend", 8080, ["database"]),
  ])]);
  const { adapter, healthCalls, orchestrator } = harness(workspace);
  adapter.startObservations.set("backend", {
    ...observation("stopped", "none"),
    message: "Stopped",
    historicalFailure: {
      message: "Flyway validation failed before the backend became ready.",
      output: "sanitized Flyway output",
      exitCode: 0,
      failedAt: "2026-10-20T15:54:18.000Z",
    },
  });

  const failed = await orchestrator.start("sandbox");
  assert.equal(failed.status, "error");
  assert.match(failed.message, /Flyway validation failed/);
  assert.deepEqual(failed.startedServiceIds, ["database"]);
  assert.deepEqual(failed.rolledBackServiceIds, ["database"]);
  assert.deepEqual(healthCalls, ["database"]);
  assert.deepEqual(adapter.calls, ["start:sandbox:database", "start:sandbox:backend", "stop:sandbox:database"]);

  adapter.startObservations.set("backend", observation("started", "devhub"));
  const retried = await orchestrator.start("sandbox");
  assert.equal(retried.status, "success");
  assert.deepEqual(retried.startedServiceIds, ["database", "backend"]);
});

test("Stop Environment is idempotent when every managed process has already exited", async () => {
  const { adapter, orchestrator } = harness(config([profile("sandbox", [processService("backend", 8080)])]));
  adapter.states.set("test-workspace:sandbox:backend", {
    ...observation("stopped", "none"),
    historicalFailure: { message: "Startup failed.", exitCode: 0, failedAt: "2026-10-20T15:54:18.000Z" },
  });

  const stopped = await orchestrator.stop("sandbox");
  assert.equal(stopped.status, "success");
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(adapter.calls, []);
});

test("coalesces duplicate starts and duplicate stops", async () => {
  const { adapter, orchestrator } = harness(config([profile("sandbox", [processService("api", 8080)])]));
  let releaseStart!: () => void;
  adapter.startBarrier = new Promise<void>((resolve) => { releaseStart = resolve; });
  const firstStart = orchestrator.start("sandbox");
  const secondStart = orchestrator.start("sandbox");
  assert.strictEqual(firstStart, secondStart);
  releaseStart();
  await firstStart;
  adapter.startBarrier = null;
  const firstStop = orchestrator.stop("sandbox");
  const secondStop = orchestrator.stop("sandbox");
  assert.strictEqual(firstStop, secondStop);
  await firstStop;
  assert.equal(adapter.calls.filter((call) => call.startsWith("start:")).length, 1);
  assert.equal(adapter.calls.filter((call) => call.startsWith("stop:")).length, 1);
});

test("serializes an opposing stop behind an in-flight start", async () => {
  const { adapter, orchestrator } = harness(config([profile("sandbox", [processService("api", 8080)])]));
  let releaseStart!: () => void;
  adapter.startBarrier = new Promise<void>((resolve) => { releaseStart = resolve; });
  const start = orchestrator.start("sandbox");
  const stop = orchestrator.stop("sandbox");
  assert.notStrictEqual(start, stop);
  releaseStart();
  assert.equal((await start).status, "success");
  assert.equal((await stop).status, "success");
  assert.deepEqual(adapter.calls, ["start:sandbox:api", "stop:sandbox:api"]);
});

test("observes healthy external services without claiming or stopping them", async () => {
  const workspace = config([profile("sandbox", [processService("database", 5433), processService("api", 8080, ["database"])])]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:sandbox:database", observation("healthy", "external"));
  const started = await orchestrator.start("sandbox");
  assert.equal(started.status, "success");
  assert.deepEqual(started.startedServiceIds, ["api"]);
  assert.equal(adapter.calls.includes("start:sandbox:database"), false);
  const stopped = await orchestrator.stop("sandbox");
  assert.match(stopped.message, /external services remain running/i);
  assert.equal(adapter.calls.includes("stop:sandbox:database"), false);
});

test("inspects aggregate health without mutating external or stopped services", async () => {
  const workspace = config([profile("sandbox", [processService("database", 5433), processService("api", 8080, ["database"])])]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:sandbox:database", observation("started", "external"));
  const result = await orchestrator.inspect("sandbox");
  assert.equal(result.status, "success");
  assert.equal(result.state, "started");
  assert.equal(result.services.find((service) => service.id === "database")?.ownership, "external");
  assert.equal(adapter.calls.length, 0);
});

test("rolls back only services newly started by a failed operation", async () => {
  const workspace = config([profile("sandbox", [
    processService("external-db", 5433),
    processService("api", 8080, ["external-db"]),
    processService("web", 3000, ["api"]),
  ])]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:sandbox:external-db", observation("healthy", "external"));
  adapter.failStart.add("web");
  const result = await orchestrator.start("sandbox");
  assert.equal(result.status, "error");
  assert.deepEqual(result.startedServiceIds, ["api"]);
  assert.deepEqual(result.rolledBackServiceIds, ["api"]);
  assert.equal(adapter.calls.includes("stop:sandbox:external-db"), false);
});

test("does not accept a newly started service whose ownership cannot be verified", async () => {
  const { adapter, orchestrator } = harness(config([profile("sandbox", [processService("database", 5433)])]));
  adapter.startObservations.set("database", {
    state: "started",
    ownership: "unverified",
    message: "The service does not actively publish 127.0.0.1:5433.",
    port: 5433,
    url: null,
  });
  const result = await orchestrator.start("sandbox");
  assert.equal(result.status, "error");
  assert.match(result.message, /does not actively publish 127\.0\.0\.1:5433/);
  assert.deepEqual(result.startedServiceIds, []);
  assert.equal(adapter.calls.includes("stop:sandbox:database"), false);
});

test("preflight detects a later port conflict before starting any dependency", async () => {
  const workspace = config([profile("sandbox", [processService("database", 5433), processService("api", 8080, ["database"])])]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:sandbox:api", observation("degraded", "unverified"));
  const result = await orchestrator.start("sandbox");
  assert.equal(result.status, "error");
  assert.ok(result.issues.some((candidate) => candidate.code === "port" && candidate.serviceId === "api"));
  assert.equal(adapter.calls.length, 0);
});

test("reports graceful shutdown failures without dropping ownership", async () => {
  const workspace = config([profile("sandbox", [processService("api", 8080)])]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:sandbox:api", observation("healthy", "devhub"));
  adapter.failStop.add("api");
  const result = await orchestrator.stop("sandbox");
  assert.equal(result.status, "error");
  assert.equal(result.state, "degraded");
  assert.equal(adapter.states.get("test-workspace:sandbox:api")?.ownership, "devhub");
});

test("blocks mutually exclusive profiles when another profile is externally observed", async () => {
  const workspace = config([
    profile("sandbox", [processService("api", 8080)]),
    profile("trial", [processService("api", 8180)]),
  ]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:trial:api", observation("healthy", "external"));
  const result = await orchestrator.start("sandbox");
  assert.equal(result.status, "error");
  assert.ok(result.issues.some((candidate) => candidate.code === "external-profile"
    && candidate.serviceId === "api"
    && /trial blocks sandbox: api is running externally/i.test(candidate.message)));
  assert.equal(adapter.calls.length, 0);
});

test("stopped mutually exclusive services do not block after ownership memory is lost on restart", async () => {
  const workspace = config([
    profile("sandbox", [processService("api", 8080)]),
    profile("trial", [processService("trial-api", 8180)]),
  ]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:trial:trial-api", {
    ...observation("stopped", "none"),
    message: "Stopped; a historical container and volume remain.",
  });

  const result = await orchestrator.start("sandbox");

  assert.equal(result.status, "success");
  assert.deepEqual(result.startedServiceIds, ["api"]);
  assert.equal(result.issues.some((candidate) => candidate.code === "external-profile"), false);
});

test("a real DevHub-owned cross-profile service remains protected with a specific diagnostic", async () => {
  const workspace = config([
    profile("sandbox", [processService("api", 8080)]),
    profile("trial", [processService("trial-api", 8180)]),
  ]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:trial:trial-api", observation("healthy", "devhub"));

  const result = await orchestrator.start("sandbox");

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((candidate) => candidate.code === "external-profile"
    && candidate.serviceId === "trial-api"
    && /trial-api is running in this DevHub session/i.test(candidate.message)));
  assert.equal(adapter.calls.length, 0);
});

test("an unverifiable cross-profile listener remains protected with its evidence", async () => {
  const workspace = config([
    profile("sandbox", [processService("api", 8080)]),
    profile("trial", [processService("trial-api", 8180)]),
  ]);
  const { adapter, orchestrator } = harness(workspace);
  adapter.states.set("test-workspace:trial:trial-api", {
    ...observation("degraded", "unverified"),
    message: "Port 8180 is listening, but its process identity is unavailable.",
  });

  const result = await orchestrator.start("sandbox");

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((candidate) => candidate.code === "external-profile"
    && candidate.serviceId === "trial-api"
    && /Port 8180 is listening, but its process identity is unavailable/i.test(candidate.message)));
  assert.equal(adapter.calls.length, 0);
});

test("keeps ownership isolated by workspace profile scope", async () => {
  const workspace = config([
    profile("sandbox", [processService("api", 8080)], "sandbox-only"),
    profile("trial", [processService("api", 8180)], "trial-only"),
  ]);
  const { adapter, orchestrator } = harness(workspace);
  const sandbox = await orchestrator.start("sandbox");
  const trial = await orchestrator.start("trial");
  assert.equal(sandbox.status, "success");
  assert.equal(trial.status, "success");
  assert.equal(adapter.states.get("test-workspace:sandbox:api")?.ownership, "devhub");
  assert.equal(adapter.states.get("test-workspace:trial:api")?.ownership, "devhub");
});

test("requires explicit confirmation before starting or stopping real-data profiles", async () => {
  const realData = { ...profile("trial", [processService("api", 8180)]), risk: "real-data" as const };
  const { adapter, orchestrator } = harness(config([realData]));
  const start = await orchestrator.start("trial");
  const stop = await orchestrator.stop("trial");
  assert.equal(start.status, "confirmation-required");
  assert.equal(stop.status, "confirmation-required");
  assert.equal(adapter.calls.length, 0);
});
