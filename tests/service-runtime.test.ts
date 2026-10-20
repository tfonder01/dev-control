import assert from "node:assert/strict";
import test from "node:test";

import { findAvailablePort } from "../lib/projects/port-allocation.ts";
import { classifyManagedProcessExit, managedStartupSignal } from "../lib/projects/process-exit.ts";
import { javaCheckCommand, nextPackageScriptCommand, packageScriptCommand, requiresWindowsCommandShell, springLaunchArgs, springWrapperCommand } from "../lib/projects/service-commands.ts";
import type { ProjectService } from "../lib/workspace/types.ts";

function service(overrides: Partial<ProjectService> & Pick<ProjectService, "id" | "name" | "path" | "relativePath" | "kind">): ProjectService {
  return {
    technologies: [],
    configurationFiles: [],
    commands: [],
    capabilities: {
      packageManager: null,
      packageScripts: [],
      hasMavenWrapper: false,
      hasGradleWrapper: false,
      hasSpringBoot: false,
      javaBuildTool: null,
      devPortHint: null,
      devPortSource: null,
    },
    ...overrides,
  };
}

test("classifies a nonzero exit during a requested managed stop separately from a crash", () => {
  assert.deepEqual(classifyManagedProcessExit(true, 1, "Backend", "Build failed."), {
    state: "stopped",
    message: "Managed shutdown verified by DevHub.",
    exitClassification: "managed-stop",
    exitCode: 1,
  });
  assert.deepEqual(classifyManagedProcessExit(false, 1, "Backend", "Build failed."), {
    state: "failed",
    message: "Build failed.",
    exitClassification: "unexpected-exit",
    exitCode: 1,
  });
});

test("treats a zero-code Gradle wrapper exit with classified Spring failure output as a startup failure", () => {
  assert.deepEqual(classifyManagedProcessExit(false, 0, "Backend", "Flyway validation failed before the backend became ready."), {
    state: "failed",
    message: "Flyway validation failed before the backend became ready.",
    exitClassification: "unexpected-exit",
    exitCode: 0,
  });
});

test("prioritizes a known wrapper exit over simultaneous port readiness", () => {
  assert.equal(managedStartupSignal(true, true), "exited");
  assert.equal(managedStartupSignal(false, true), "ready");
  assert.equal(managedStartupSignal(false, false), "pending");
});

test("builds fixed Next.js commands in the service working directory", () => {
  const frontend = service({
    id: "AAAAAAAAAAAAAAAA",
    name: "frontend",
    path: "C:\\repo\\frontend",
    relativePath: "frontend",
    kind: "node",
    technologies: [{ name: "Next.js", tone: "slate" }],
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
  });
  assert.deepEqual(packageScriptCommand(frontend, "dev", "win32"), {
    executable: "pnpm.cmd",
    args: ["dev"],
    cwd: "C:\\repo\\frontend",
  });
  assert.deepEqual(nextPackageScriptCommand(frontend, "dev", "127.0.0.1", 3002, "win32"), {
    executable: "pnpm.cmd",
    args: ["dev", "--hostname", "127.0.0.1", "--port", "3002"],
    cwd: "C:\\repo\\frontend",
  });
  assert.deepEqual(packageScriptCommand(frontend, "build", "win32"), {
    executable: "pnpm.cmd",
    args: ["build"],
    cwd: "C:\\repo\\frontend",
  });
  assert.deepEqual(nextPackageScriptCommand(frontend, "start", "127.0.0.1", 3002, "win32"), {
    executable: "pnpm.cmd",
    args: ["start", "--hostname", "127.0.0.1", "--port", "3002"],
    cwd: "C:\\repo\\frontend",
  });
  assert.throws(() => packageScriptCommand(frontend, "test", "win32"));
  assert.throws(() => nextPackageScriptCommand(frontend, "dev", "127.0.0.1", 0, "win32"));
  assert.throws(() => nextPackageScriptCommand(frontend, "dev", "127.0.0.1 & whoami", 3002, "win32"));
});

test("forwards explicit Next.js bindings through npm's argument separator", () => {
  const frontend = service({
    id: "NNNNNNNNNNNNNNNN",
    name: "frontend",
    path: "C:\\repo\\frontend",
    relativePath: "frontend",
    kind: "node",
    technologies: [{ name: "Next.js", tone: "slate" }],
    capabilities: {
      packageManager: "npm",
      packageScripts: ["dev", "start"],
      hasMavenWrapper: false,
      hasGradleWrapper: false,
      hasSpringBoot: false,
      javaBuildTool: null,
      devPortHint: 3000,
      devPortSource: "framework-default",
    },
  });
  assert.deepEqual(nextPackageScriptCommand(frontend, "start", "127.0.0.1", 3002, "win32").args, [
    "run", "start", "--", "--hostname", "127.0.0.1", "--port", "3002",
  ]);
});

test("builds allowlisted Gradle wrapper launch and checks in the backend directory", () => {
  const backend = service({
    id: "BBBBBBBBBBBBBBBB",
    name: "backend",
    path: "C:\\repo\\backend",
    relativePath: "backend",
    kind: "spring-boot",
    capabilities: {
      packageManager: null,
      packageScripts: [],
      hasMavenWrapper: false,
      hasGradleWrapper: true,
      hasSpringBoot: true,
      javaBuildTool: "gradle",
      devPortHint: 8080,
      devPortSource: "framework-default",
    },
  });
  assert.deepEqual(springWrapperCommand(backend, 8084, "win32"), {
    executable: ".\\gradlew.bat",
    args: ["--no-daemon", "bootRun", "--args=--server.port=8084"],
    cwd: "C:\\repo\\backend",
  });
  assert.deepEqual(springWrapperCommand(backend, 8084, "win32", "local"), {
    executable: ".\\gradlew.bat",
    args: ["--no-daemon", "bootRun", "--args=--server.port=8084 --spring.profiles.active=local"],
    cwd: "C:\\repo\\backend",
  });
  assert.deepEqual(javaCheckCommand(backend, "build", "win32"), {
    executable: ".\\gradlew.bat",
    args: ["build"],
    cwd: "C:\\repo\\backend",
  });
  assert.equal(javaCheckCommand(backend, "verify", "win32"), null);
  assert.equal(requiresWindowsCommandShell(".\\gradlew.bat", "win32"), true);
  assert.equal(requiresWindowsCommandShell(".\\mvnw.cmd", "win32"), true);
  assert.equal(requiresWindowsCommandShell("./gradlew", "linux"), false);
});

test("adds an explicitly configured Maven Spring profile without changing the default launch", () => {
  const backend = service({
    id: "MMMMMMMMMMMMMMMM",
    name: "backend",
    path: "C:\\repo\\backend",
    relativePath: ".",
    kind: "spring-boot",
    capabilities: {
      packageManager: null,
      packageScripts: [],
      hasMavenWrapper: true,
      hasGradleWrapper: false,
      hasSpringBoot: true,
      javaBuildTool: "maven",
      devPortHint: 8080,
      devPortSource: "framework-default",
    },
  });
  assert.deepEqual(springLaunchArgs(backend, 8080), [
    "spring-boot:run",
    "-Dspring-boot.run.arguments=--server.port=8080",
  ]);
  assert.deepEqual(springWrapperCommand(backend, 8080, "win32", "dev"), {
    executable: ".\\mvnw.cmd",
    args: [
      "spring-boot:run",
      "-Dspring-boot.run.profiles=dev",
      "-Dspring-boot.run.arguments=--server.port=8080",
    ],
    cwd: "C:\\repo\\backend",
  });
});

test("keeps bounded automatic port conflict resolution shared across services", async () => {
  const listening = new Set([3000, 3002]);
  const reserved = new Set([3001]);
  const selected = await findAvailablePort(3000, reserved, async (port) => listening.has(port));
  assert.equal(selected, 3003);
  assert.equal(await findAvailablePort(65_535, new Set([65_535]), async () => false), null);
});

test("keeps service command working directories independent", () => {
  const base = {
    kind: "node" as const,
    technologies: [],
    configurationFiles: [],
    commands: [],
    capabilities: {
      packageManager: "npm" as const,
      packageScripts: ["dev" as const],
      hasMavenWrapper: false,
      hasGradleWrapper: false,
      hasSpringBoot: false,
      javaBuildTool: null,
      devPortHint: null,
      devPortSource: null,
    },
  };
  const web = service({ ...base, id: "CCCCCCCCCCCCCCCC", name: "web", path: "C:\\repo\\web", relativePath: "web" });
  const admin = service({ ...base, id: "DDDDDDDDDDDDDDDD", name: "admin", path: "C:\\repo\\admin", relativePath: "admin" });
  assert.equal(packageScriptCommand(web, "dev", "win32").cwd, "C:\\repo\\web");
  assert.equal(packageScriptCommand(admin, "dev", "win32").cwd, "C:\\repo\\admin");
});
