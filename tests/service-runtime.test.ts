import assert from "node:assert/strict";
import test from "node:test";

import { findAvailablePort } from "../lib/projects/port-allocation.ts";
import { javaCheckCommand, packageScriptCommand, requiresWindowsCommandShell, springWrapperCommand } from "../lib/projects/service-commands.ts";
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

test("builds fixed Next.js commands in the service working directory", () => {
  const frontend = service({
    id: "AAAAAAAAAAAAAAAA",
    name: "frontend",
    path: "C:\\repo\\frontend",
    relativePath: "frontend",
    kind: "node",
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
  assert.throws(() => packageScriptCommand(frontend, "test", "win32"));
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
    args: ["bootRun", "--args=--server.port=8084"],
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
