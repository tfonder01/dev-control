import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveProgramInvocation, runInitializationStages, validateSpawnCwd } from "../lib/projects/project-operation-runtime.ts";
import { resolveSafeDestination } from "../lib/projects/validation.ts";

const execFileAsync = promisify(execFile);

test("resolves pnpm through the Windows command processor and keeps git on PATH", () => {
  const pnpm = resolveProgramInvocation("pnpm", "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.deepEqual(pnpm, {
    executable: "C:\\Windows\\System32\\cmd.exe",
    argsPrefix: ["/d", "/s", "/c", "pnpm.cmd"],
  });
  assert.deepEqual(resolveProgramInvocation("git", "win32", {}), { executable: "git", argsPrefix: [] });
  assert.deepEqual(resolveProgramInvocation("pnpm", "linux", {}), { executable: "pnpm", argsPrefix: [] });
});

test("runs the resolved pnpm command from a valid path containing spaces", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "DevHub Operations "));
  try {
    await validateSpawnCwd(directory);
    const invocation = resolveProgramInvocation("pnpm");
    const { stdout } = await execFileAsync(invocation.executable, [...invocation.argsPrefix, "--version"], {
      cwd: directory,
      windowsHide: true,
      timeout: 10_000,
    });
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing, relative, and non-directory command working directories", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-cwd-"));
  const filePath = path.join(directory, "not-a-directory.txt");
  await writeFile(filePath, "test", "utf8");
  try {
    await assert.rejects(validateSpawnCwd("relative-path"), /working directory is invalid/i);
    await assert.rejects(validateSpawnCwd(path.join(directory, "missing")), /does not exist/i);
    await assert.rejects(validateSpawnCwd(filePath), /not a directory/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a partial clone/scaffold failure and removes only the owned destination", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runInitializationStages("nextjs", {
      ensureRemoteIsEmpty: async () => { calls.push("remote"); },
      reserveDestination: async () => { calls.push("reserve"); },
      cloneRepository: async () => { calls.push("clone"); },
      scaffoldNextApp: async () => { calls.push("scaffold"); throw new Error("spawn EINVAL"); },
      addOptionalFiles: async () => { calls.push("optional"); return []; },
      removeDestination: async () => { calls.push("cleanup"); },
    }),
    /Repository cloned, but Next\.js scaffolding failed\. DevHub removed the incomplete local destination, so retrying is safe\./,
  );
  assert.deepEqual(calls, ["remote", "reserve", "clone", "scaffold", "cleanup"]);
});

test("completes the empty-repository Next.js initialization stages in order", async () => {
  const calls: string[] = [];
  const result = await runInitializationStages("nextjs", {
    ensureRemoteIsEmpty: async () => { calls.push("remote"); },
    reserveDestination: async () => { calls.push("reserve"); },
    cloneRepository: async () => { calls.push("clone"); },
    scaffoldNextApp: async () => { calls.push("scaffold"); },
    addOptionalFiles: async () => { calls.push("optional"); return ["README.md"]; },
    removeDestination: async () => { calls.push("cleanup"); },
  });
  assert.deepEqual(calls, ["remote", "reserve", "clone", "scaffold", "optional"]);
  assert.deepEqual(result, { skippedFiles: ["README.md"] });
});

test("a reservation race never cleans up or overwrites an existing destination", async () => {
  let cleaned = false;
  await assert.rejects(
    runInitializationStages("existing", {
      ensureRemoteIsEmpty: async () => undefined,
      reserveDestination: async () => { throw Object.assign(new Error("already exists"), { code: "EEXIST" }); },
      cloneRepository: async () => { throw new Error("must not run"); },
      scaffoldNextApp: async () => { throw new Error("must not run"); },
      addOptionalFiles: async () => [],
      removeDestination: async () => { cleaned = true; },
    }),
    /No existing files were changed/,
  );
  assert.equal(cleaned, false);
});

test("destination validation supports spaced roots and preserves existing contents", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "DevHub Workspace "));
  const categoryPath = path.join(workspaceRoot, "Internal Products");
  const destination = path.join(categoryPath, "lead-scout");
  await mkdir(destination, { recursive: true });
  const sentinel = path.join(destination, "keep.txt");
  await writeFile(sentinel, "keep", "utf8");
  try {
    const existing = await resolveSafeDestination(workspaceRoot, "Internal Products", "lead-scout");
    assert.deepEqual(existing, { ok: false, error: "A file or folder already exists at that destination." });
    const available = await resolveSafeDestination(workspaceRoot, "Internal Products", "another-project");
    assert.equal(available.ok, true);
    assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(sentinel, "utf8")), "keep");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
