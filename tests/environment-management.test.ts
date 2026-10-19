import assert from "node:assert/strict";
import test from "node:test";

import { buildEnvironmentManagementView, createEnvironmentManagementHandler } from "../lib/projects/environment-management.ts";
import type { WorkspaceEnvironmentConfig } from "../lib/projects/environment-config.ts";
import type { EnvironmentProfileCatalog, ManagedEnvironmentConfig } from "../lib/projects/environment-config-store.ts";

const revision = "abcdefghijklmnopqrst";

function catalog(): EnvironmentProfileCatalog {
  const workspace: WorkspaceEnvironmentConfig = {
      version: 1,
      id: "example",
      name: "Example",
      repositories: [{ id: "application", repositoryId: "aaaaaaaaaaaaaaaa" }],
      externalEnvironmentFiles: [{ id: "private-local", pathVariable: "PRIVATE_LOCAL_ROOT", relativePath: "app.env" }],
      profiles: [{
        id: "sandbox",
        name: "Sandbox",
        risk: "local",
        exclusiveGroup: "example-environment",
        loopbackOnly: true,
        openUrl: "http://127.0.0.1:3002/",
        services: [{
          id: "database",
          name: "PostgreSQL",
          adapter: "docker-compose",
          repository: "application",
          composeFile: "infrastructure/docker-compose.yml",
          projectName: "devhub-established",
          services: ["postgres"],
          dependsOn: [],
          environment: {},
          environmentFiles: [{ source: "repository", repository: "application", path: "infrastructure/.env" }],
          healthChecks: [{ type: "docker-health", service: "postgres", timeoutMs: 60_000 }],
          host: "127.0.0.1",
          port: 5433,
        }, {
          id: "frontend",
          name: "Frontend",
          adapter: "node",
          repository: "application",
          serviceId: "bbbbbbbbbbbbbbbb",
          launchMode: "preview",
          dependsOn: ["database"],
          environment: { API_URL: "http://127.0.0.1:8080" },
          environmentFiles: [{ source: "repository", repository: "application", path: "frontend/.env.local" }],
          healthChecks: [{ type: "http", url: "http://127.0.0.1:3002/", expectedStatuses: [200], timeoutMs: 90_000, allowInvalidCertificate: false }],
          host: "127.0.0.1",
          port: 3002,
        }],
      }],
    };
  return {
    version: 1,
    revision,
    managedRevision: revision,
    sources: { "example:sandbox": "shipped" },
    trustedProfiles: { example: workspace.profiles },
    workspaces: [workspace],
  };
}

function setup(stopped = true) {
  let saved: ManagedEnvironmentConfig | null = null;
  let stopChecks = 0;
  const base = catalog();
  const handler = createEnvironmentManagementHandler({
    loadCatalog: async () => base,
    loadManaged: async () => ({ config: { version: 1, workspaces: [] }, revision }),
    saveManaged: async (config, expectedRevision) => {
      assert.equal(expectedRevision, revision);
      saved = config;
      return "uvwxyzabcdefghijklmn";
    },
    isStopped: async () => {
      stopChecks += 1;
      return stopped;
    },
  });
  return { base, handler, saved: () => saved, stopChecks: () => stopChecks };
}

function requestProfile() {
  const base = catalog();
  return buildEnvironmentManagementView(base, base.workspaces[0]).profiles[0];
}

test("editing a shipped profile writes a local override while preserving trusted runtime identity", async () => {
  const state = setup();
  const profile = requestProfile();
  profile.name = "Local Sandbox";
  profile.services[1].port = 3003;
  profile.services[1].healthCheck.path = "/health";
  const response = await state.handler({
    repositoryId: "aaaaaaaaaaaaaaaa",
    workspaceId: "example",
    operation: "edit",
    expectedRevision: revision,
    sourceProfileId: "sandbox",
    confirmedRemove: false,
    profile,
  });
  assert.equal(response.status, "success");
  assert.equal(state.stopChecks(), 1);
  const override = state.saved()?.workspaces[0].profiles[0];
  assert.ok(override);
  const database = override.services[0];
  const frontend = override.services[1];
  assert.equal(database.adapter, "docker-compose");
  if (database.adapter === "docker-compose") {
    assert.equal(database.projectName, "devhub-established");
    assert.equal(database.composeFile, "infrastructure/docker-compose.yml");
    assert.deepEqual(database.services, ["postgres"]);
  }
  assert.equal(frontend.adapter, "node");
  if (frontend.adapter === "node") {
    assert.equal(frontend.serviceId, "bbbbbbbbbbbbbbbb");
    assert.equal(frontend.port, 3003);
    assert.equal(frontend.environment.API_URL, "http://127.0.0.1:8080");
    assert.equal(frontend.healthChecks[0].type, "http");
    if (frontend.healthChecks[0].type === "http") assert.equal(frontend.healthChecks[0].url, "http://127.0.0.1:3003/health");
  }
});

test("creation and duplication accept only server-authorized templates and approved environment references", async () => {
  const state = setup(false);
  const profile = requestProfile();
  profile.id = "sandbox-copy";
  profile.name = "Sandbox Copy";
  profile.services[1].externalEnvironmentFiles = ["private-local"];
  const duplicated = await state.handler({
    repositoryId: "aaaaaaaaaaaaaaaa",
    workspaceId: "example",
    operation: "duplicate",
    expectedRevision: revision,
    sourceProfileId: "sandbox",
    confirmedRemove: false,
    profile,
  });
  assert.equal(duplicated.status, "success");
  assert.equal(state.stopChecks(), 0);
  const node = state.saved()?.workspaces[0].profiles[0].services[1];
  assert.deepEqual(node?.environmentFiles, [
    { source: "repository", repository: "application", path: "frontend/.env.local" },
    { source: "external", reference: "private-local" },
  ]);

  const injected = requestProfile();
  injected.id = "unsafe-copy";
  injected.services[0].templateId = "attacker:command";
  injected.services[1].externalEnvironmentFiles = ["unapproved-private-file"];
  const rejected = await state.handler({
    repositoryId: "aaaaaaaaaaaaaaaa",
    workspaceId: "example",
    operation: "add",
    expectedRevision: revision,
    sourceProfileId: null,
    confirmedRemove: false,
    profile: injected,
  });
  assert.equal(rejected.status, "error");
  assert.match(JSON.stringify(rejected.fieldErrors), /trusted discovered service|approved server-side/);
});

test("running profiles cannot be edited or removed, and stale revisions cannot overwrite configuration", async () => {
  const running = setup(false);
  const profile = requestProfile();
  assert.equal((await running.handler({ repositoryId: "aaaaaaaaaaaaaaaa", workspaceId: "example", operation: "edit", expectedRevision: revision, sourceProfileId: "sandbox", confirmedRemove: false, profile })).status, "error");
  assert.equal(running.saved(), null);
  assert.equal((await running.handler({ repositoryId: "aaaaaaaaaaaaaaaa", workspaceId: "example", operation: "remove", expectedRevision: revision, sourceProfileId: "sandbox", confirmedRemove: true, profile: null })).status, "error");
  assert.equal(running.saved(), null);

  const stale = setup();
  const response = await stale.handler({ repositoryId: "aaaaaaaaaaaaaaaa", workspaceId: "example", operation: "edit", expectedRevision: "00000000000000000000", sourceProfileId: "sandbox", confirmedRemove: false, profile });
  assert.equal(response.status, "error");
  assert.match(response.message, /changed since/);
  assert.equal(stale.stopChecks(), 0);
});

test("removing shipped and managed profiles changes only overlay metadata", async () => {
  const shipped = setup();
  const removed = await shipped.handler({ repositoryId: "aaaaaaaaaaaaaaaa", workspaceId: "example", operation: "remove", expectedRevision: revision, sourceProfileId: "sandbox", confirmedRemove: true, profile: null });
  assert.equal(removed.status, "success");
  assert.deepEqual(shipped.saved()?.workspaces[0], { id: "example", profiles: [], removedProfileIds: ["sandbox"] });
  assert.match(removed.message, /Runtime resources and project files were not changed/);
  const hiddenCatalog = catalog();
  hiddenCatalog.workspaces[0] = { ...hiddenCatalog.workspaces[0], profiles: [] };
  const hiddenView = buildEnvironmentManagementView(hiddenCatalog, hiddenCatalog.workspaces[0]);
  assert.equal(hiddenView.profiles.length, 0);
  assert.deepEqual(hiddenView.templates.map((template) => template.adapter), ["docker-compose", "node"]);

  const unconfirmed = setup();
  assert.equal((await unconfirmed.handler({ repositoryId: "aaaaaaaaaaaaaaaa", workspaceId: "example", operation: "remove", expectedRevision: revision, sourceProfileId: "sandbox", confirmedRemove: false, profile: null })).status, "error");
  assert.equal(unconfirmed.saved(), null);
});

test("profile validation rejects duplicate ports and dependency cycles before persistence", async () => {
  const state = setup();
  const profile = requestProfile();
  profile.services[1].port = 5433;
  profile.services[0].dependsOn = ["frontend"];
  const response = await state.handler({ repositoryId: "aaaaaaaaaaaaaaaa", workspaceId: "example", operation: "edit", expectedRevision: revision, sourceProfileId: "sandbox", confirmedRemove: false, profile });
  assert.equal(response.status, "error");
  assert.match(JSON.stringify(response.fieldErrors), /Conflicts|cycle/i);
  assert.equal(state.saved(), null);
});
