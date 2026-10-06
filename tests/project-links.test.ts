import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectLinksStore } from "../lib/projects/project-links-store.ts";
import { detectProjectLinks } from "../lib/projects/project-link-detection.ts";
import { resolveProjectLinks } from "../lib/projects/project-links-resolution.ts";
import { parseProjectLinksForm, parseWorkspaceLinksForm, validateCustomLinkLabel, validateProjectUrl } from "../lib/projects/project-links-validation.ts";
import type { Repository } from "../lib/workspace/types.ts";

function repositoryAt(repositoryPath: string): Repository {
  return {
    id: "AAAAAAAAAAAAAAAA",
    name: "example",
    path: repositoryPath,
    relativePath: "example",
    technologies: [],
    configurationFiles: [],
    commands: [],
    capabilities: { packageManager: null, packageScripts: [], hasMavenWrapper: false, hasSpringBoot: false, devPortHint: null, devPortSource: null },
    git: { branch: "main", isDirty: false, changedFileCount: 0, changedFiles: [], hasConflicts: false, upstreamRemote: "origin", upstreamBranch: "main", ahead: 0, behind: 0, latestCommitHash: null, latestCommitSubject: null, latestCommitTimestamp: null, originUrl: "git@github.com:owner/example.git", githubUrl: "https://github.com/owner/example", error: null },
  };
}

test("accepts and normalizes only http and https project URLs", () => {
  assert.equal(validateProjectUrl("https://example.com/app").ok, true);
  assert.equal(validateProjectUrl("http://localhost:3000/path").ok, true);
  assert.equal(validateProjectUrl("javascript:alert(1)").ok, false);
  assert.equal(validateProjectUrl("file:///C:/secrets.txt").ok, false);
  assert.equal(validateProjectUrl("shell:open").ok, false);
  assert.equal(validateProjectUrl("https://user:password@example.com").ok, false);
});

test("custom labels are short plain text", () => {
  assert.deepEqual(validateCustomLinkLabel(" Admin Portal "), { ok: true, label: "Admin Portal" });
  assert.equal(validateCustomLinkLabel("<script>alert(1)</script>").ok, false);
  assert.equal(validateCustomLinkLabel("a".repeat(41)).ok, false);
  assert.equal(validateCustomLinkLabel("line\nbreak").ok, false);
});

test("parses optional known and custom links without requiring every field", () => {
  const formData = new FormData();
  formData.set("link-production", "https://example.com");
  formData.set("link-render", "");
  formData.append("custom-label", "Admin Portal");
  formData.append("custom-url", "https://admin.example.com/login");
  const result = parseProjectLinksForm(formData);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.links.production, "https://example.com/");
  assert.deepEqual(result.config.customLinks, [{ label: "Admin Portal", url: "https://admin.example.com/login" }]);
});

test("rejects invalid protocols in known and custom links", () => {
  const formData = new FormData();
  formData.set("link-staging", "javascript:alert(1)");
  formData.append("custom-label", "Local file");
  formData.append("custom-url", "file:///C:/secrets.txt");
  const result = parseProjectLinksForm(formData);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.fieldErrors["link-staging"], /http or https/i);
  assert.match(result.fieldErrors["custom-0-url"], /http or https/i);
});

test("workspace links use the same strict URL and custom-label validation", () => {
  const formData = new FormData();
  formData.set("link-github", "https://github.com/owner");
  formData.set("link-vercel", "data:text/html,unsafe");
  formData.append("custom-label", "<b>Docs</b>");
  formData.append("custom-url", "https://docs.example.com");
  const result = parseWorkspaceLinksForm(formData);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.fieldErrors["link-vercel"], /http or https/i);
  assert.match(result.fieldErrors["custom-0-label"], /plain text/i);
});

test("cleared inputs remove links from the normalized configuration", () => {
  const formData = new FormData();
  formData.set("link-production", "");
  formData.append("custom-label", "");
  formData.append("custom-url", "");
  const result = parseProjectLinksForm(formData);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.config, { links: {}, customLinks: [] });
});

test("persists repository-keyed metadata across store instances without removing other projects", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-project-links-"));
  const metadataPath = path.join(directory, "projects.json");
  try {
    const firstStore = createProjectLinksStore(metadataPath);
    await firstStore.save("AAAAAAAAAAAAAAAA", { links: { production: "https://one.example/" }, customLinks: [] });
    await firstStore.save("BBBBBBBBBBBBBBBB", { links: { staging: "https://two.example/" }, customLinks: [{ label: "Admin", url: "https://admin.example/" }] });
    await firstStore.saveWorkspace({ links: { github: "https://github.com/owner" }, customLinks: [{ label: "Standards", url: "https://docs.example/" }] });

    const restartedStore = createProjectLinksStore(metadataPath);
    assert.equal((await restartedStore.get("AAAAAAAAAAAAAAAA")).links.production, "https://one.example/");
    assert.deepEqual(await restartedStore.get("BBBBBBBBBBBBBBBB"), {
      links: { staging: "https://two.example/" },
      customLinks: [{ label: "Admin", url: "https://admin.example/" }],
    });
    assert.deepEqual(await restartedStore.getWorkspace(), {
      links: { github: "https://github.com/owner" },
      customLinks: [{ label: "Standards", url: "https://docs.example/" }],
    });
    const persisted = JSON.parse(await readFile(metadataPath, "utf8")) as { version: number; projects: Record<string, unknown> };
    assert.equal(persisted.version, 1);
    assert.deepEqual(Object.keys(persisted.projects).sort(), ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adds workspace links to a legacy version 1 file without discarding project links", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-project-links-migration-"));
  const metadataPath = path.join(directory, "projects.json");
  try {
    await writeFile(metadataPath, JSON.stringify({ version: 1, projects: { AAAAAAAAAAAAAAAA: { links: { render: "https://dashboard.render.com/web/example" }, customLinks: [] } } }), "utf8");
    const store = createProjectLinksStore(metadataPath);
    await store.saveWorkspace({ links: { sentry: "https://sentry.io/" }, customLinks: [] });
    assert.equal((await store.get("AAAAAAAAAAAAAAAA")).links.render, "https://dashboard.render.com/web/example");
    assert.equal((await store.getWorkspace()).links.sentry, "https://sentry.io/");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual project links override detection and removal falls back to the detected URL", () => {
  const detected = { github: "https://github.com/owner/example", production: "https://detected.example/" } as const;
  const configured = { links: { production: "https://configured.example/" }, customLinks: [] };
  const overridden = resolveProjectLinks(configured, detected).find((link) => link.kind === "production");
  assert.equal(overridden?.url, "https://configured.example/");
  assert.equal(overridden?.provenance, "configured");
  const fallback = resolveProjectLinks({ links: {}, customLinks: [] }, detected).find((link) => link.kind === "production");
  assert.equal(fallback?.url, "https://detected.example/");
  assert.equal(fallback?.provenance, "detected");
});

test("detects only strong project-link evidence and never returns secret values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-link-detection-"));
  try {
    await mkdir(path.join(directory, ".vercel"));
    await writeFile(path.join(directory, ".vercel", "project.json"), JSON.stringify({ projectName: "example-app", orgSlug: "example-team", projectId: "prj_safe" }), "utf8");
    await writeFile(path.join(directory, ".env.production"), [
      "NEXT_PUBLIC_APP_URL=https://app.acme.test",
      "SENTRY_ORG=example-org",
      "SENTRY_PROJECT=example-app",
      "SENTRY_DSN=https://secret-value@errors.example/1",
      "API_TOKEN=never-render-this",
    ].join("\n"), "utf8");
    const detected = await detectProjectLinks(repositoryAt(directory));
    assert.deepEqual(detected, {
      github: "https://github.com/owner/example",
      vercel: "https://vercel.com/example-team/example-app",
      production: "https://app.acme.test/",
      sentry: "https://sentry.io/organizations/example-org/projects/example-app/",
    });
    assert.equal(JSON.stringify(detected).includes("secret-value"), false);
    assert.equal(JSON.stringify(detected).includes("never-render-this"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not guess when deployment URL evidence is ambiguous", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-link-ambiguity-"));
  try {
    await writeFile(path.join(directory, ".env.production"), "NEXT_PUBLIC_APP_URL=https://one.example\nSITE_URL=https://also-one.example\nSENTRY_ORG=one-org\nSENTRY_PROJECT=one-project\n", "utf8");
    await writeFile(path.join(directory, ".env.production.local"), "NEXT_PUBLIC_APP_URL=https://two.example\n", "utf8");
    await writeFile(path.join(directory, ".env.staging"), "SENTRY_ORG=two-org\nSENTRY_PROJECT=two-project\n", "utf8");
    const detected = await detectProjectLinks(repositoryAt(directory));
    assert.equal(detected.production, undefined);
    assert.equal(detected.sentry, undefined);
    assert.equal(detected.github, "https://github.com/owner/example");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
