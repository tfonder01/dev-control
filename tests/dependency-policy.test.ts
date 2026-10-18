import assert from "node:assert/strict";
import test from "node:test";

import { dependencyControlPolicy } from "../lib/projects/dependency-policy.ts";

test("verified legacy dependencies remain read-only unless this DevHub session started them", () => {
  assert.deepEqual(dependencyControlPolicy({
    manageable: true,
    identityAvailable: true,
    sameManagedProfile: false,
    states: ["ready"],
  }), { ownedByDevHub: false, canStart: false, canStop: false });
});

test("legacy controls start only a verified stopped profile and stop only an in-session owned profile", () => {
  assert.deepEqual(dependencyControlPolicy({
    manageable: true,
    identityAvailable: true,
    sameManagedProfile: false,
    states: ["stopped"],
  }), { ownedByDevHub: false, canStart: true, canStop: false });
  assert.deepEqual(dependencyControlPolicy({
    manageable: true,
    identityAvailable: true,
    sameManagedProfile: true,
    states: ["ready"],
  }), { ownedByDevHub: true, canStart: false, canStop: true });
  assert.deepEqual(dependencyControlPolicy({
    manageable: true,
    identityAvailable: true,
    sameManagedProfile: false,
    states: ["unverified"],
  }), { ownedByDevHub: false, canStart: false, canStop: false });
});
