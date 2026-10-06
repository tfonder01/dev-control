import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { commitAndPush, type GitRunner } from "../lib/projects/git-operations.ts";
import type { Repository } from "../lib/workspace/types.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

function repository(repositoryPath: string, id = "testrepo00000001"): Repository {
  return {
    id,
    name: path.basename(repositoryPath),
    path: repositoryPath,
    relativePath: path.basename(repositoryPath),
    technologies: [],
    configurationFiles: [],
    commands: [],
    capabilities: { packageManager: null, packageScripts: [], hasMavenWrapper: false, hasSpringBoot: false, devPortHint: null, devPortSource: null },
    git: {
      branch: "feature", isDirty: true, changedFileCount: 1, changedFiles: ["change.txt"], hasConflicts: false,
      upstreamRemote: "origin", upstreamBranch: "feature", ahead: 0, behind: 0,
      latestCommitHash: null, latestCommitSubject: null, latestCommitTimestamp: null,
      originUrl: null, githubUrl: null, error: null,
    },
  };
}

async function initialize(branch = "feature", pushUpstream = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "devhub-git-"));
  const work = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  await mkdir(work);
  await git(work, "init", "--initial-branch", branch);
  await git(work, "config", "user.name", "DevHub Test");
  await git(work, "config", "user.email", "devhub@example.invalid");
  await git(work, "config", "commit.gpgsign", "false");
  await git(work, "config", "core.hooksPath", ".git/hooks");
  await writeFile(path.join(work, "README.md"), "base\n", "utf8");
  await git(work, "add", "README.md");
  await git(work, "commit", "-m", "Initial commit");
  await git(root, "init", "--bare", remote);
  await git(work, "remote", "add", "origin", remote);
  if (pushUpstream) await git(work, "push", "--set-upstream", "origin", branch);
  return { root, work, remote, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const confirmed = { confirmProtectedBranch: true, confirmSetUpstream: true, expectedChangedFiles: ["change.txt"] };

test("commits all changes with the exact message, pushes only the current branch, and leaves a clean tree", async () => {
  const fixture = await initialize();
  try {
    await git(fixture.work, "branch", "unpublished-side-work");
    await writeFile(path.join(fixture.work, "change.txt"), "committed\n", "utf8");
    const result = await commitAndPush(repository(fixture.work), { commitMessage: "Focused Git workflow", ...confirmed });

    assert.equal(result.status, "success");
    assert.equal(result.pushed, true);
    assert.match(result.commitHash ?? "", /^[0-9a-f]{12}$/);
    assert.equal(await git(fixture.work, "status", "--porcelain"), "");
    assert.equal(await git(fixture.work, "log", "-1", "--format=%s"), "Focused Git workflow");
    assert.equal(await git(fixture.remote, "log", "-1", "--format=%s", "refs/heads/feature"), "Focused Git workflow");
    await assert.rejects(git(fixture.remote, "show-ref", "--verify", "refs/heads/unpublished-side-work"));
  } finally {
    await fixture.cleanup();
  }
});

test("requires explicit no-upstream confirmation before staging, then sets origin/current-branch upstream", async () => {
  const fixture = await initialize("feature/no-upstream", false);
  try {
    await writeFile(path.join(fixture.work, "change.txt"), "change\n", "utf8");
    const pending = await commitAndPush(repository(fixture.work), {
      commitMessage: "Publish branch", confirmProtectedBranch: false, confirmSetUpstream: false, expectedChangedFiles: ["change.txt"],
    });
    assert.equal(pending.status, "confirmation-required");
    assert.equal(pending.reason, "missing-upstream");
    assert.equal(await git(fixture.work, "diff", "--cached", "--name-only"), "");

    const result = await commitAndPush(repository(fixture.work), {
      commitMessage: "Publish branch", confirmProtectedBranch: false, confirmSetUpstream: true, expectedChangedFiles: ["change.txt"],
    });
    assert.equal(result.status, "success");
    assert.equal(await git(fixture.work, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"), "origin/feature/no-upstream");
  } finally {
    await fixture.cleanup();
  }
});

for (const branch of ["main", "master", "develop"]) {
  test(`${branch} requires protected-branch confirmation before staging`, async () => {
    const fixture = await initialize(branch);
    try {
      await writeFile(path.join(fixture.work, "change.txt"), "change\n", "utf8");
      const result = await commitAndPush(repository(fixture.work), {
        commitMessage: "Protected update", confirmProtectedBranch: false, confirmSetUpstream: false, expectedChangedFiles: ["change.txt"],
      });
      assert.equal(result.status, "confirmation-required");
      assert.equal(result.reason, "protected-branch");
      assert.equal(await git(fixture.work, "diff", "--cached", "--name-only"), "");
    } finally {
      await fixture.cleanup();
    }
  });
}

test("a failing commit hook prevents push", async () => {
  const fixture = await initialize();
  try {
    const remoteBefore = await git(fixture.remote, "rev-parse", "refs/heads/feature");
    const hook = path.join(fixture.work, ".git", "hooks", "pre-commit");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(hook, 0o755);
    await writeFile(path.join(fixture.work, "change.txt"), "blocked\n", "utf8");

    const result = await commitAndPush(repository(fixture.work), { commitMessage: "Must fail", ...confirmed });
    assert.equal(result.status, "error");
    assert.match(result.message, /commit hook/i);
    assert.equal(await git(fixture.remote, "rev-parse", "refs/heads/feature"), remoteBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("blocks unresolved conflicts", async () => {
  const fixture = await initialize("main");
  try {
    await git(fixture.work, "checkout", "-b", "topic");
    await writeFile(path.join(fixture.work, "README.md"), "topic\n", "utf8");
    await git(fixture.work, "commit", "-am", "Topic");
    await git(fixture.work, "checkout", "main");
    await writeFile(path.join(fixture.work, "README.md"), "main\n", "utf8");
    await git(fixture.work, "commit", "-am", "Main");
    await assert.rejects(git(fixture.work, "merge", "topic"));

    const result = await commitAndPush(repository(fixture.work), { commitMessage: "Conflict", ...confirmed });
    assert.equal(result.status, "error");
    assert.match(result.message, /resolve all merge conflicts/i);
  } finally {
    await fixture.cleanup();
  }
});

test("blocks detached HEAD", async () => {
  const fixture = await initialize();
  try {
    await git(fixture.work, "checkout", "--detach");
    await writeFile(path.join(fixture.work, "change.txt"), "detached\n", "utf8");
    const result = await commitAndPush(repository(fixture.work), { commitMessage: "Detached", ...confirmed });
    assert.equal(result.status, "error");
    assert.match(result.message, /detached/i);
  } finally {
    await fixture.cleanup();
  }
});

test("reports a missing remote without staging", async () => {
  const fixture = await initialize("feature", false);
  try {
    await git(fixture.work, "remote", "remove", "origin");
    await writeFile(path.join(fixture.work, "change.txt"), "change\n", "utf8");
    const result = await commitAndPush(repository(fixture.work), { commitMessage: "No remote", ...confirmed });
    assert.equal(result.status, "error");
    assert.match(result.message, /origin remote is unavailable/i);
    assert.equal(await git(fixture.work, "diff", "--cached", "--name-only"), "");
  } finally {
    await fixture.cleanup();
  }
});

test("refuses to stage when the working tree changed after the displayed list was captured", async () => {
  const fixture = await initialize();
  try {
    await writeFile(path.join(fixture.work, "change.txt"), "change\n", "utf8");
    await writeFile(path.join(fixture.work, "unexpected.txt"), "new\n", "utf8");
    const result = await commitAndPush(repository(fixture.work), { commitMessage: "Stale list", ...confirmed });
    assert.equal(result.status, "error");
    assert.match(result.message, /working tree changed/i);
    assert.equal(await git(fixture.work, "diff", "--cached", "--name-only"), "");
  } finally {
    await fixture.cleanup();
  }
});

test("reports non-fast-forward without reconciling and keeps the new commit local", async () => {
  const fixture = await initialize();
  const other = path.join(fixture.root, "other");
  try {
    await git(fixture.root, "clone", fixture.remote, other);
    await git(other, "checkout", "feature");
    await git(other, "config", "user.name", "Other Test");
    await git(other, "config", "user.email", "other@example.invalid");
    await writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
    await git(other, "add", "remote.txt");
    await git(other, "commit", "-m", "Remote commit");
    await git(other, "push", "origin", "feature");

    await writeFile(path.join(fixture.work, "local.txt"), "local\n", "utf8");
    const result = await commitAndPush(repository(fixture.work), { commitMessage: "Local commit", ...confirmed, expectedChangedFiles: ["local.txt"] });
    assert.equal(result.status, "error");
    assert.equal(result.pushed, false);
    assert.match(result.message, /reconciled separately/i);
    assert.equal(await git(fixture.work, "log", "-1", "--format=%s"), "Local commit");
    assert.equal(await git(fixture.remote, "log", "-1", "--format=%s", "refs/heads/feature"), "Remote commit");
  } finally {
    await fixture.cleanup();
  }
});

test("passes shell metacharacters as literal commit-message text", async () => {
  const fixture = await initialize();
  try {
    const marker = path.join(fixture.work, "owned-by-shell.txt");
    const message = "Literal $(touch owned-by-shell.txt) & echo safe";
    await writeFile(path.join(fixture.work, "change.txt"), "safe\n", "utf8");
    const result = await commitAndPush(repository(fixture.work), { commitMessage: message, ...confirmed });
    assert.equal(result.status, "success");
    assert.equal(await git(fixture.work, "log", "-1", "--format=%s"), message);
    await assert.rejects(readFile(marker, "utf8"));
  } finally {
    await fixture.cleanup();
  }
});

test("rejects duplicate operations for the same repository", async () => {
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let calls = 0;
  const runner: GitRunner = async () => {
    calls += 1;
    await probeGate;
    return { ok: false, stdout: "", stderr: "", exitCode: 1, unavailable: false };
  };
  const target = repository(path.join(os.tmpdir(), "duplicate-target"), "duplicate0000001");
  const first = commitAndPush(target, { commitMessage: "First", ...confirmed }, runner);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await commitAndPush(target, { commitMessage: "Second", ...confirmed }, runner);
  assert.equal(duplicate.status, "error");
  assert.match(duplicate.message, /already running/i);
  releaseProbe();
  await first;
  assert.equal(calls, 1);
});
