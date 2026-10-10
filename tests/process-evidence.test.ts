import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyUnmanagedListener,
  consistentWindowsListenerSnapshot,
  listenerBelongsToWindowsLaunch,
  listenerMatchesServicePath,
  type WindowsProcessEvidence,
} from "../lib/projects/process-evidence.ts";

function process(
  pid: number,
  parentPid: number,
  executablePath: string | null,
  commandLine: string | null,
): WindowsProcessEvidence {
  return { pid, parentPid, creationTime: `${pid}-created`, executablePath, commandLine };
}

test("classifies an unrelated listener on the preferred port as occupied", () => {
  const processes = new Map([
    [4100, process(4100, 4000, "C:\\Program Files\\nodejs\\node.exe", 'node "C:\\dev\\dev-control\\node_modules\\next\\dist\\server\\lib\\start-server.js"')],
    [4000, process(4000, 0, "C:\\Windows\\System32\\cmd.exe", "pnpm.cmd dev")],
  ]);

  assert.equal(classifyUnmanagedListener(4100, "C:\\repos\\SentryWorth\\frontend", processes), "port-in-use");
  assert.equal(classifyUnmanagedListener(null, "C:\\repos\\SentryWorth\\frontend", processes), "port-in-use");
});

test("classifies an externally launched Next.js listener only when its lineage references the service path", () => {
  const processes = new Map([
    [5100, process(5100, 5000, "C:\\Program Files\\nodejs\\node.exe", 'node "C:/repos/SentryWorth/frontend/node_modules/next/dist/server/lib/start-server.js"')],
    [5000, process(5000, 0, "C:\\Windows\\System32\\cmd.exe", "pnpm.cmd dev")],
  ]);

  assert.equal(classifyUnmanagedListener(5100, "C:\\repos\\SentryWorth\\frontend", processes), "external");
  assert.equal(listenerMatchesServicePath(5100, "C:\\repos\\SentryWorth\\frontend", processes), true);
});

test("uses listener ancestry for an externally launched Spring Boot service", () => {
  const processes = new Map([
    [6100, process(6100, 6000, "C:\\Program Files\\Java\\bin\\java.exe", "java -cp app.jar com.example.Application")],
    [6000, process(6000, 0, "C:\\Windows\\System32\\cmd.exe", 'gradlew.bat -p "C:\\repos\\SentryWorth\\backend" bootRun')],
  ]);

  assert.equal(classifyUnmanagedListener(6100, "C:\\repos\\SentryWorth\\backend", processes), "external");
});

test("does not confuse sibling monorepo services or path prefixes", () => {
  const processes = new Map([
    [7100, process(7100, 0, "C:\\Program Files\\nodejs\\node.exe", 'node "C:\\repos\\suite\\frontend-admin\\node_modules\\next\\dist\\server.js"')],
    [7200, process(7200, 0, "C:\\Program Files\\nodejs\\node.exe", 'node "C:\\repos\\suite\\frontend\\node_modules\\next\\dist\\server.js"')],
  ]);

  assert.equal(classifyUnmanagedListener(7100, "C:\\repos\\suite\\frontend", processes), "port-in-use");
  assert.equal(classifyUnmanagedListener(7200, "C:\\repos\\suite\\frontend", processes), "external");
  assert.equal(classifyUnmanagedListener(7200, "C:\\repos\\suite\\backend", processes), "port-in-use");
});

test("recognizes a Spring Boot JVM in a DevHub-owned Gradle wrapper tree", () => {
  const root = process(8000, 7000, "C:\\Windows\\System32\\cmd.exe", 'cmd.exe /c .\\gradlew.bat --no-daemon bootRun');
  const processes = new Map([
    [8000, root],
    [8100, process(8100, 8000, "C:\\Java\\bin\\java.exe", "org.gradle.wrapper.GradleWrapperMain --no-daemon bootRun")],
    [8200, process(8200, 8100, "C:\\Java\\bin\\java.exe", "org.gradle.launcher.daemon.bootstrap.GradleDaemon")],
    [8300, process(8300, 8200, "C:\\Java\\bin\\java.exe", 'com.example.Application --server.port=8084')],
  ]);

  assert.equal(listenerBelongsToWindowsLaunch(processes.get(8300), root, null, processes), true);
});

test("retains exact listener ownership after Gradle wrapper parents exit", () => {
  const captured = process(8300, 8200, "C:\\Java\\bin\\java.exe", 'com.example.Application --server.port=8084');
  const processes = new Map([[8300, captured]]);
  const reusedPid = {
    ...process(8300, 8200, "C:\\Java\\bin\\java.exe", 'unrelated.Application --server.port=8084'),
    creationTime: "reused-later",
  };

  assert.equal(listenerBelongsToWindowsLaunch(captured, null, captured, processes), true);
  assert.equal(
    listenerBelongsToWindowsLaunch(
      reusedPid,
      null,
      captured,
      new Map([[8300, reusedPid]]),
    ),
    false,
  );
});

test("refuses listeners from a reusable Gradle daemon outside the launched tree", () => {
  const root = process(9000, 7000, "C:\\Windows\\System32\\cmd.exe", 'cmd.exe /c .\\gradlew.bat bootRun');
  const processes = new Map([
    [9000, root],
    [9100, process(9100, 9000, "C:\\Java\\bin\\java.exe", "org.gradle.wrapper.GradleWrapperMain bootRun")],
    [9200, process(9200, 1, "C:\\Java\\bin\\java.exe", "org.gradle.launcher.daemon.bootstrap.GradleDaemon")],
    [9300, process(9300, 9200, "C:\\Java\\bin\\java.exe", 'com.example.Application --server.port=8084')],
  ]);

  assert.equal(listenerBelongsToWindowsLaunch(processes.get(9300), root, null, processes), false);
});

test("keeps independent service listener trees isolated", () => {
  const apiRoot = process(10000, 7000, "C:\\Windows\\System32\\cmd.exe", "gradlew.bat --no-daemon bootRun");
  const workerRoot = process(11000, 7000, "C:\\Windows\\System32\\cmd.exe", "pnpm.cmd dev");
  const processes = new Map([
    [10000, apiRoot],
    [10001, process(10001, 10000, "C:\\Java\\bin\\java.exe", "com.example.Api --server.port=8084")],
    [11000, workerRoot],
    [11001, process(11001, 11000, "C:\\Program Files\\nodejs\\node.exe", "next dev --port 3000")],
  ]);

  assert.equal(listenerBelongsToWindowsLaunch(processes.get(10001), apiRoot, null, processes), true);
  assert.equal(listenerBelongsToWindowsLaunch(processes.get(11001), apiRoot, null, processes), false);
  assert.equal(listenerBelongsToWindowsLaunch(processes.get(10001), workerRoot, null, processes), false);
});

test("accepts only a listener captured consistently around the process snapshot", () => {
  const listener = process(12000, 11000, "C:\\Java\\bin\\java.exe", "com.example.Application --server.port=3001");
  const processes = new Map([[listener.pid, listener]]);

  assert.deepEqual(consistentWindowsListenerSnapshot(12000, 12000, processes), { listener, processes });
  assert.equal(consistentWindowsListenerSnapshot(12000, 12001, processes), null);
  assert.equal(consistentWindowsListenerSnapshot(12000, 12000, new Map()), null);
  assert.equal(consistentWindowsListenerSnapshot(12000, 12000, null), null);
});
