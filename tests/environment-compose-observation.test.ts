import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import { parseWorkspaceEnvironmentConfigFile } from "../lib/projects/environment-config.ts";
import * as runtimeConfig from "../lib/projects/runtime-config.ts";
import type { EnvironmentAdapterContext, EnvironmentRuntimeAdapter } from "../lib/projects/environment-orchestrator.ts";

// Load the server adapter with isolated filesystem/CLI dependencies. No Docker or
// application process can be launched by these tests.
const containerId = "a".repeat(64);
const containerName = "sentrywealth-production-trial-restored-postgres-trial-1";

async function fixture(options: {
  state?: "exited" | "running" | "missing";
  volume?: string;
  containerProject?: string;
  configFile?: string;
  host?: string;
  observeOnly?: boolean;
  backupStartsFirst?: boolean;
} = {}) {
  const manifest = JSON.parse(await readFile("config/environment-profiles.json", "utf8"));
  if (options.observeOnly) {
    manifest.workspaces[0].profiles[1].services[0].observeOnly = true;
    delete manifest.workspaces[0].profiles[1].services[0].startExisting;
  }
  const parsed = parseWorkspaceEnvironmentConfigFile(manifest);
  assert.ok(parsed.ok);
  const config = parsed.config.workspaces[0];
  const profile = config.profiles.find((candidate) => candidate.id === "production-trial")!;
  const service = profile.services[0];
  assert.equal(service.adapter, "docker-compose");
  const root = path.resolve("fixture-repository");
  const composePath = path.resolve(root, service.adapter === "docker-compose" ? service.composeFile : "");
  const calls: string[][] = [];
  let state = options.state ?? "running";
  let health = state === "running" ? "healthy" : null;
  const require = createRequire(import.meta.url);
  const source = await readFile("lib/projects/environment-adapters.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  const module = { exports: {} as { createEnvironmentAdapterRegistry: (controller: unknown) => Record<string, EnvironmentRuntimeAdapter> } };
  const dependencies: Record<string, unknown> = {
    "server-only": {},
    "./processes": {},
    "./process-status": {},
    "./service-resolution": {},
    "./runtime-environment": {},
    "./runtime-config": runtimeConfig,
    "node:util": { promisify: (fn: (...args: unknown[]) => void) => (...args: unknown[]) => new Promise((resolve, reject) => fn(...args, (error: unknown, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))) },
    "node:fs/promises": { realpath: async (file: string) => file, stat: async () => ({ isFile: () => true }) },
    "node:child_process": {
      execFile: (executable: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        calls.push(args);
        if (executable === "where.exe") return callback(null, "docker.exe", "");
        if (args[1] === "start") {
          assert.deepEqual(args, ["container", "start", containerId]);
          state = "running";
          health = "starting";
          return callback(options.backupStartsFirst ? new Error("Already running") : null, "", "");
        }
        assert.deepEqual(args.slice(0, 3), ["container", "inspect", "--format"]);
        assert.equal(args.at(-1), containerName);
        if (state === "missing") return callback(new Error("Missing container"), "", "");
        const ports = { "5432/tcp": [{ HostIp: options.host ?? "127.0.0.1", HostPort: "5434" }] };
        callback(null, JSON.stringify([
          containerId, `/${containerName}`,
          {
            "com.docker.compose.project": options.containerProject ?? "sentrywealth-production-trial-restored",
            "com.docker.compose.project.config_files": options.configFile ?? composePath,
            "com.docker.compose.service": "postgres-trial",
          },
          [{ Type: "volume", Name: options.volume ?? "sentrywealth_production_trial_restored_data", Destination: "/var/lib/postgresql/data", RW: true }],
          ports, state === "running" ? ports : null, state, health,
        ]), "");
      },
    },
  };
  new Function("require", "module", "exports", compiled.outputText)((name: string) => name in dependencies ? dependencies[name] : require(name), module, module.exports);
  const adapter = module.exports.createEnvironmentAdapterRegistry({})["docker-compose"];
  const context = {
    config, profile, service, runtimeScope: "observation-test", environment: {}, redactions: [], sources: [],
    repositories: [{ id: config.repositories[0].repositoryId, path: root }],
  } as unknown as EnvironmentAdapterContext;
  return { adapter, context, calls, markHealthy: () => { health = "healthy"; } };
}

test("restored Trial database is healthy and external; lifecycle calls cannot mutate it", async () => {
  const { adapter, context, calls } = await fixture({ observeOnly: true });
  const status = await adapter.inspect(context);
  assert.equal(status.state, "healthy");
  assert.equal(status.ownership, "external");
  assert.equal((await adapter.probe!({ type: "docker-health", service: "postgres-trial", timeoutMs: 60000 }, context)).healthy, true);
  const readCalls = calls.length;
  await assert.rejects(adapter.start(context), /observe-only/);
  await assert.rejects(adapter.stop(context, { graceful: true }), /scheduled backups/);
  assert.equal(calls.length, readCalls);
});

test("starts only the verified existing container and waits for its own Docker health", async () => {
  for (const backupStartsFirst of [false, true]) {
    const { adapter, context, calls, markHealthy } = await fixture({ state: "exited", backupStartsFirst });
    assert.equal((await adapter.inspect(context)).state, "stopped");
    const started = await adapter.start(context);
    assert.equal(started.state, "started");
    assert.equal(started.ownership, "external");
    const check = { type: "docker-health", service: "postgres-trial", timeoutMs: 60000 } as const;
    assert.equal((await adapter.probe!(check, context)).healthy, false);
    markHealthy();
    assert.equal((await adapter.probe!(check, context)).healthy, true);
    await adapter.start(context);
    await assert.rejects(adapter.stop(context, { graceful: true }), /scheduled backups/);
    assert.deepEqual(calls.filter((args) => args[1] === "start"), [["container", "start", containerId]]);
  }
});

test("missing, legacy or mismatched Trial resources never trigger a start", async () => {
  for (const options of [
    { state: "missing" } as const,
    { volume: "sentrywealth_production_trial_data" },
    { containerProject: "sentrywealth-production-trial" },
    { configFile: "infrastructure/docker-compose.production-trial.yml" },
    { host: "0.0.0.0" },
  ]) {
    const { adapter, context, calls } = await fixture(options);
    assert.equal((await adapter.inspect(context)).ownership, "unverified");
    await assert.rejects(adapter.start(context), /could not be verified/);
    assert.equal(calls.some((args) => args[1] === "start"), false);
  }
});

test("observeOnly rejects non-boolean values", async () => {
  const manifest = JSON.parse(await readFile("config/environment-profiles.json", "utf8"));
  manifest.workspaces[0].profiles[1].services[0].observeOnly = "true";
  assert.equal(parseWorkspaceEnvironmentConfigFile(manifest).ok, false);
});
