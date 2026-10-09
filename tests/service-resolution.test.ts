import assert from "node:assert/strict";
import test from "node:test";

import { resolveProjectService, serviceRuntimeKey } from "../lib/projects/service-resolution.ts";
import type { ProjectService, Repository } from "../lib/workspace/types.ts";

const capabilities = {
  packageManager: "pnpm" as const,
  packageScripts: ["dev" as const],
  hasMavenWrapper: false,
  hasGradleWrapper: false,
  hasSpringBoot: false,
  javaBuildTool: null,
  devPortHint: 3000,
  devPortSource: "framework-default" as const,
};
const service: ProjectService = {
  id: "AAAAAAAAAAAAAAAA",
  name: "frontend",
  path: "C:\\trusted\\repo\\frontend",
  relativePath: "frontend",
  kind: "node",
  technologies: [],
  configurationFiles: ["frontend/package.json"],
  commands: [],
  capabilities,
};
const repository = {
  id: "RRRRRRRRRRRRRRRR",
  name: "repo",
  path: "C:\\trusted\\repo",
  relativePath: "repo",
  technologies: [],
  configurationFiles: [],
  services: [service],
  infrastructure: [],
  git: {
    branch: "main",
    isDirty: false,
    changedFileCount: 0,
    changedFiles: [],
    hasConflicts: false,
    upstreamRemote: null,
    upstreamBranch: null,
    ahead: null,
    behind: null,
    latestCommitHash: null,
    latestCommitSubject: null,
    latestCommitTimestamp: null,
    originUrl: null,
    githubUrl: null,
    error: null,
  },
} satisfies Repository;

test("resolves only opaque service IDs from the trusted repository snapshot", () => {
  assert.equal(resolveProjectService(repository, service.id), service);
  assert.equal(resolveProjectService(repository, "../../frontend"), null);
  assert.equal(resolveProjectService(repository, "BBBBBBBBBBBBBBBB"), null);
  assert.equal(resolveProjectService(repository, undefined), null);
});

test("uses independent process ownership keys for services in one repository", () => {
  assert.equal(serviceRuntimeKey(repository.id, "AAAAAAAAAAAAAAAA"), "RRRRRRRRRRRRRRRR:AAAAAAAAAAAAAAAA");
  assert.notEqual(
    serviceRuntimeKey(repository.id, "AAAAAAAAAAAAAAAA"),
    serviceRuntimeKey(repository.id, "BBBBBBBBBBBBBBBB"),
  );
});
