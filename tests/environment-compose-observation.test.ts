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
async function fixture(running = true) {
  const manifest = JSON.parse(await readFile("config/environment-profiles.json", "utf8"));
  const parsed = parseWorkspaceEnvironmentConfigFile(manifest);
  assert.ok(parsed.ok);
  const config = parsed.config.workspaces[0];
  const profile = config.profiles.find((candidate) => candidate.id === "production-trial")!;
  const service = profile.services[0];
  assert.equal(service.adapter, "docker-compose");
  const root = path.resolve("fixture-repository");
  const composePath = path.resolve(root, service.adapter === "docker-compose" ? service.composeFile : "");
  const calls: string[][] = [];
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
    "node:util": { promisify: (fn: (...args: unknown[]) => void) => (...args: unknown[]) => new Promise((resolve) => fn(...args, (_error: unknown, stdout: string, stderr: string) => resolve({ stdout, stderr }))) },
    "node:fs/promises": { realpath: async (file: string) => file, stat: async () => ({ isFile: () => true }) },
    "node:child_process": {
      execFile: (executable: string, args: string[], options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
        calls.push(args);
        assert.ok(executable === "where.exe" || args.includes("ps"), "only executable lookup and status are allowed");
        const stdout = executable === "where.exe" ? "docker.exe" : JSON.stringify(running ? [{
          Service: "postgres-trial", Project: "sentrywealth-production-trial-restored",
          Labels: `com.docker.compose.project.config_files=${composePath}`,
          State: "running", Health: "healthy",
          Publishers: [{ URL: "127.0.0.1", PublishedPort: 5434, TargetPort: 5432, Protocol: "tcp" }],
        }] : []);
        callback(null, stdout, "");
      },
    },
  };
  new Function("require", "module", "exports", compiled.outputText)((name: string) => name in dependencies ? dependencies[name] : require(name), module, module.exports);
  const adapter = module.exports.createEnvironmentAdapterRegistry({})["docker-compose"];
  const context = {
    config, profile, service, runtimeScope: "observation-test", environment: {}, redactions: [], sources: [],
    repositories: [{ id: config.repositories[0].repositoryId, path: root }],
  } as unknown as EnvironmentAdapterContext;
  return { adapter, context, calls };
}

test("restored Trial database is healthy and external; lifecycle calls cannot mutate it", async () => {
  const { adapter, context, calls } = await fixture();
  const status = await adapter.inspect(context);
  assert.equal(status.state, "healthy");
  assert.equal(status.ownership, "external");
  assert.equal((await adapter.probe!({ type: "docker-health", service: "postgres-trial", timeoutMs: 60000 }, context)).healthy, true);
  const readCalls = calls.length;
  await assert.rejects(adapter.start(context), /observe-only/);
  await assert.rejects(adapter.stop(context, { graceful: true }), /observe-only/);
  assert.equal(calls.length, readCalls);
});

test("missing restored Trial database cannot fall through to Compose provisioning", async () => {
  const { adapter, context, calls } = await fixture(false);
  assert.equal((await adapter.inspect(context)).state, "stopped");
  const readCalls = calls.length;
  await assert.rejects(adapter.start(context), /must already be running/);
  assert.equal(calls.length, readCalls);
});

test("observeOnly rejects non-boolean values", async () => {
  const manifest = JSON.parse(await readFile("config/environment-profiles.json", "utf8"));
  manifest.workspaces[0].profiles[1].services[0].observeOnly = "true";
  assert.equal(parseWorkspaceEnvironmentConfigFile(manifest).ok, false);
});
