import assert from "node:assert/strict";
import test from "node:test";

import { environmentControlState, sanitizeEnvironmentDiagnostic, sanitizeEnvironmentLogTail, type EnvironmentProfileView } from "../lib/projects/environment-view.ts";

function profile(overrides: Partial<EnvironmentProfileView> = {}): EnvironmentProfileView {
  return {
    id: "sandbox",
    name: "Sandbox",
    risk: "local",
    openUrl: "http://127.0.0.1:3000/",
    state: "stopped",
    guidance: [],
    services: [{
      id: "frontend",
      name: "Frontend",
      runtimeType: "Node / Next.js",
      port: 3000,
      url: null,
      state: "stopped",
      ownership: "none",
      stage: "Stopped",
      endpoint: "127.0.0.1:3000",
      diagnostic: "Stopped",
      exitSummary: null,
      recentLogs: null,
      defaultLaunchMode: "dev",
      runningLaunchMode: null,
    }],
    ...overrides,
  };
}

test("UI controls reflect stopped, owned, external, unverified, and pending states", () => {
  assert.deepEqual(environmentControlState(profile(), false), { canStart: true, canStop: false, canRestart: false, canOpen: false });
  const owned = profile({ state: "healthy", services: [{ ...profile().services[0], state: "healthy", ownership: "devhub" }] });
  assert.deepEqual(environmentControlState(owned, false), { canStart: false, canStop: true, canRestart: true, canOpen: true });
  const external = profile({ state: "healthy", services: [{ ...profile().services[0], state: "healthy", ownership: "external" }] });
  assert.deepEqual(environmentControlState(external, false), { canStart: false, canStop: false, canRestart: false, canOpen: true });
  const unverified = profile({ state: "degraded", services: [{ ...profile().services[0], state: "degraded", ownership: "unverified" }] });
  assert.equal(environmentControlState(unverified, false).canStart, false);
  assert.deepEqual(environmentControlState(owned, true), { canStart: false, canStop: false, canRestart: false, canOpen: false });
});

test("runtime log tails are bounded and redact sensitive identity and financial fields", () => {
  const logs = Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n")
    + "\npassword=hunter2 accountNumber=123456 amount=99.50 owner@example.com 123e4567-e89b-42d3-a456-426614174000"
    + "\n{\"token\":\"private-token\",\"routingNumber\":\"987654321\"}";
  const result = sanitizeEnvironmentLogTail(logs);
  assert.ok(result);
  assert.equal(result.includes("line 0"), false);
  assert.equal(result.includes("hunter2"), false);
  assert.equal(result.includes("123456"), false);
  assert.equal(result.includes("99.50"), false);
  assert.equal(result.includes("owner@example.com"), false);
  assert.equal(result.includes("123e4567-e89b-42d3-a456-426614174000"), false);
  assert.equal(result.includes("private-token"), false);
  assert.equal(result.includes("987654321"), false);
});

test("browser diagnostics redact credentials, assignments, and bearer tokens", () => {
  const diagnostic = sanitizeEnvironmentDiagnostic("failed password=hunter2 Bearer abc123 at postgresql://user:pass@localhost/db\nsecret line");
  assert.equal(diagnostic.includes("hunter2"), false);
  assert.equal(diagnostic.includes("abc123"), false);
  assert.equal(diagnostic.includes(":pass@"), false);
  assert.equal(diagnostic.includes("secret line"), false);
});
