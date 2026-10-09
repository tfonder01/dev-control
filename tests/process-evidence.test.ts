import assert from "node:assert/strict";
import test from "node:test";

import { classifyUnmanagedListener, listenerMatchesServicePath, type WindowsProcessEvidence } from "../lib/projects/process-evidence.ts";

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
