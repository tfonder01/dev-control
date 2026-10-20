import assert from "node:assert/strict";
import test from "node:test";

import { clearHistoricalProcessOwnership, managedProcessObservation } from "../lib/projects/process-status.ts";

test("maps a retained startup failure to stopped without retaining live ownership", () => {
  const historicalFailure = {
    message: "Flyway validation failed before the backend became ready.",
    output: "sanitized failure output",
    exitCode: 0,
    failedAt: "2026-10-20T15:54:18.000Z",
  };
  const observation = managedProcessObservation({
    state: "stopped",
    ownedByDevHub: false,
    port: 8080,
    url: null,
    startedAt: "2026-10-20T15:54:09.000Z",
    message: "Stopped",
    historicalFailure,
    launchMode: null,
  });

  assert.equal(observation.state, "stopped");
  assert.equal(observation.ownership, "none");
  assert.equal(observation.recentLogs, null);
  assert.deepEqual(observation.historicalFailure, historicalFailure);
});

test("keeps external and unverifiable listeners outside DevHub ownership", () => {
  const external = managedProcessObservation({ state: "external", ownedByDevHub: false, port: 8080, url: "http://127.0.0.1:8080", startedAt: null, message: "External", launchMode: null });
  const conflict = managedProcessObservation({ state: "port-in-use", ownedByDevHub: false, port: 8080, url: null, startedAt: null, message: "Conflict", launchMode: null });
  assert.equal(external.ownership, "external");
  assert.equal(conflict.ownership, "unverified");
});

test("normalizes a stale owned failure record into separate stopped history", () => {
  const normalized = clearHistoricalProcessOwnership({
    state: "failed",
    ownedByDevHub: true,
    port: 8080,
    url: null,
    startedAt: "2026-10-20T15:54:09.000Z",
    message: "Backend exited unexpectedly (code 0).",
    output: "retained output",
    exitClassification: "unexpected-exit",
    exitCode: 0,
    launchMode: null,
  }, "2026-10-20T15:54:18.000Z");

  assert.equal(normalized.state, "stopped");
  assert.equal(normalized.ownedByDevHub, false);
  assert.equal(normalized.exitClassification, undefined);
  assert.equal(normalized.historicalFailure?.output, "retained output");
});
