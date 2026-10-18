import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentActionHandler, type AuthorizedEnvironmentTarget } from "../lib/projects/environment-action-handler.ts";

const validRequest = {
  repositoryId: "aaaaaaaaaaaaaaaa",
  workspaceId: "wealth-workspace",
  profileId: "sandbox",
  action: "start" as const,
  confirmedRealData: false,
};

function target(risk: AuthorizedEnvironmentTarget["risk"] = "local") {
  let calls = 0;
  let launchModes: Record<string, "dev" | "preview"> = {};
  const value: AuthorizedEnvironmentTarget = {
    risk,
    nodeServiceIds: ["frontend"],
    execute: async (_action, _confirmedRealData, requestedLaunchModes) => {
      calls += 1;
      launchModes = requestedLaunchModes;
      return { status: "success", message: "Completed.", profile: null };
    },
  };
  return { value, calls: () => calls, launchModes: () => launchModes };
}

test("rejects invalid IDs and fixed-action violations before resolving a target", async () => {
  let resolutions = 0;
  const handler = createEnvironmentActionHandler(async () => {
    resolutions += 1;
    return target().value;
  });
  assert.equal((await handler({ ...validRequest, profileId: "../sandbox" })).status, "error");
  assert.equal((await handler({ ...validRequest, action: "run-command" })).status, "error");
  assert.equal((await handler({ ...validRequest, confirmedRealData: "yes" })).status, "error");
  assert.equal((await handler({ ...validRequest, command: "arbitrary.exe" })).status, "error");
  assert.equal(resolutions, 0);
});

test("authorizes an environment against all opaque identifiers", async () => {
  const execution = target();
  const handler = createEnvironmentActionHandler(async (repositoryId, workspaceId, profileId) => (
    repositoryId === validRequest.repositoryId && workspaceId === validRequest.workspaceId && profileId === validRequest.profileId
      ? execution.value
      : null
  ));
  assert.equal((await handler({ ...validRequest, workspaceId: "other-workspace" })).status, "error");
  assert.equal(execution.calls(), 0);
  assert.equal((await handler(validRequest)).status, "success");
  assert.equal(execution.calls(), 1);
});

test("accepts only allowlisted frontend mode overrides", async () => {
  const execution = target();
  const handler = createEnvironmentActionHandler(async () => execution.value);
  assert.equal((await handler({ ...validRequest, launchModes: { frontend: "preview" } })).status, "success");
  assert.deepEqual(execution.launchModes(), { frontend: "preview" });
  assert.equal((await handler({ ...validRequest, launchModes: { frontend: "production" } })).status, "error");
  assert.equal((await handler({ ...validRequest, launchModes: { unknown: "dev" } })).status, "error");
  assert.equal(execution.calls(), 1);
});

test("requires server-side real-data confirmation for lifecycle actions", async () => {
  const execution = target("real-data");
  const handler = createEnvironmentActionHandler(async () => execution.value);
  const denied = await handler({ ...validRequest, profileId: "production-trial" });
  assert.equal(denied.status, "confirmation-required");
  assert.equal(execution.calls(), 0);
  const confirmed = await handler({ ...validRequest, profileId: "production-trial", confirmedRealData: true });
  assert.equal(confirmed.status, "success");
  assert.equal(execution.calls(), 1);
});

test("inspection does not require real-data lifecycle confirmation", async () => {
  const execution = target("real-data");
  const handler = createEnvironmentActionHandler(async () => execution.value);
  assert.equal((await handler({ ...validRequest, action: "inspect" })).status, "success");
  assert.equal(execution.calls(), 1);
});
