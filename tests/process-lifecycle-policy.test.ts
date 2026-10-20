import assert from "node:assert/strict";
import test from "node:test";

import { trustedGracefulStopPolicy, unverifiedWindowsOwnershipPolicy } from "../lib/projects/process-lifecycle-policy.ts";

test("an inconclusive listener check retains the managed launch for a safe retry", () => {
  const policy = unverifiedWindowsOwnershipPolicy(true);

  assert.equal(policy.retainManagedProcess, true);
  assert.equal(policy.state, "starting");
  assert.match(policy.message, /Nothing was stopped; retry/i);
});

test("a missing port still retains the launch until its root identity can be verified", () => {
  const policy = unverifiedWindowsOwnershipPolicy(false);

  assert.equal(policy.retainManagedProcess, true);
  assert.equal(policy.state, "starting");
  assert.match(policy.message, /process identity/i);
});

test("a trusted graceful stop requires the current listener to remain ownership-verified", () => {
  assert.equal(trustedGracefulStopPolicy(true, true).runGracefulStop, true);
  assert.equal(trustedGracefulStopPolicy(true, false).runGracefulStop, false);
  assert.equal(trustedGracefulStopPolicy(false, true).runGracefulStop, false);
  assert.match(trustedGracefulStopPolicy(true, false).message, /not run.*ownership was not verified/i);
});
