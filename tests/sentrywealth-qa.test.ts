import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { qaCommand, qaSuites, SentryWealthQa, type QaRun, type QaSuite } from "../lib/projects/sentrywealth-qa.ts";

async function waitFor(qa: SentryWealthQa, ready: (run: QaRun) => boolean) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = qa.status();
    if (run && ready(run)) return run;
    await delay(25);
  }
  assert.fail(`QA status did not reach the expected state: ${JSON.stringify(qa.status())}`);
}

test("QA allowlists exactly the three suites and relies on the runner's default options", () => {
  for (const suite of qaSuites) {
    const command = qaCommand("powershell.exe", "repository", "wrapper.ps1", suite);
    assert.equal(command.cwd, "repository");
    assert.equal(command.executable, "powershell.exe");
    assert.deepEqual(command.args.slice(-4), ["-File", "wrapper.ps1", "-Suite", suite]);
    assert.equal(command.args.includes("-UpdateSnapshots"), false);
  }
  assert.throws(() => qaCommand("powershell.exe", "repository", "wrapper.ps1", "ProductionTrial" as QaSuite), /Unknown QA suite/);
});

test("QA reserves the run before command preparation and publishes logs, elapsed time, and exit status", async () => {
  const qa = new SentryWealthQa();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const first = qa.start("FullStack", async () => {
    await barrier;
    return {
      executable: process.execPath,
      cwd: process.cwd(),
      args: ["-e", "console.log('isolated output'); setTimeout(() => process.exit(1), 250)"],
    };
  });
  assert.equal(qa.status()?.state, "running");
  await assert.rejects(qa.start("Visual", async () => assert.fail("must not prepare a second command")), /already active/);
  release();
  await first;
  const active = await waitFor(qa, (run) => run.output.includes("isolated output"));
  assert.equal(active.state, "running");
  await assert.rejects(qa.start("All", async () => assert.fail("must not spawn a second command")), /already active/);
  qa.cancel(active.id + 1);
  const failed = await waitFor(qa, (run) => run.state === "failed");
  assert.ok(failed.elapsedMs >= active.elapsedMs);
  await qa.start("Visual", async () => ({ executable: process.execPath, cwd: process.cwd(), args: ["-e", "console.log('passed')"] }));
  const passed = await waitFor(qa, (run) => run.state === "passed");
  assert.match(passed.output, /passed/);
  assert.ok(passed.id > failed.id);
});

test("cancelling during preparation holds the QA reservation and skips launch", async () => {
  const qa = new SentryWealthQa();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const first = qa.start("All", async () => {
    await barrier;
    return qaCommand("powershell.exe", process.cwd(), "unused.ps1", "All");
  }, () => assert.fail("a cancelled command must not spawn"));
  qa.cancel(qa.status()!.id);
  assert.equal(qa.status()?.cancelling, true);
  await assert.rejects(qa.start("Visual", async () => assert.fail("cleanup reservation was lost")), /already active/);
  release();
  await first;
  assert.equal(qa.status()?.state, "cancelled");
});

test("Windows cancellation runs the PowerShell runner's finally block", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devhub-qa-test-"));
  const scripts = path.join(root, "scripts");
  const runner = path.join(scripts, "qa.ps1");
  const native = path.join(scripts, "wait.cjs");
  const cleanup = path.join(root, "cleanup.txt");
  const interrupted = path.join(root, "interrupted.txt");
  const qa = new SentryWealthQa();
  await mkdir(scripts);
  try {
    await writeFile(native, [
      "process.once('SIGINT', () => {",
      "  require('node:fs').writeFileSync('interrupted.txt', 'interrupted');",
      "  process.exit(130);",
      "});",
      "console.log('Ready ' + process.argv[2]);",
      "setTimeout(() => {}, 8000);",
    ].join("\n"));
    await writeFile(runner, [
      "param([string]$Suite)",
      "try {",
      "    node.exe (Join-Path $PSScriptRoot 'wait.cjs') $Suite",
      "} finally {",
      "    node.exe -e \"require('node:fs').writeFileSync('cleanup.txt', 'cleaned')\"",
      "}",
    ].join("\r\n"));
    await qa.start("Visual", async () => qaCommand("powershell.exe", root, path.resolve("scripts/run-sentrywealth-qa.ps1"), "Visual"));
    const run = await waitFor(qa, (candidate) => candidate.output.includes("Ready Visual"));
    qa.cancel(run.id);
    const cancelled = await waitFor(qa, (candidate) => candidate.state !== "running");
    assert.equal(cancelled.state, "cancelled", cancelled.output);
    assert.equal(await readFile(interrupted, "utf8"), "interrupted");
    assert.equal(await readFile(cleanup, "utf8"), "cleaned");
  } finally {
    await Promise.all([runner, native, cleanup, interrupted].map((file) => rm(file, { force: true })));
    await rmdir(scripts);
    await rmdir(root);
  }
});
