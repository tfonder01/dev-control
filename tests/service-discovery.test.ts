import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { detectStack } from "../lib/workspace/stack-detector.ts";

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-services-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function write(target: string, contents: string) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

test("preserves a standalone Next.js repository as one root service", async (context) => {
  const root = await fixture(context);
  await write(path.join(root, "package.json"), JSON.stringify({
    name: "standalone",
    packageManager: "pnpm@12.3.4",
    scripts: { dev: "next dev", build: "next build", start: "next start", lint: "eslint" },
    dependencies: { next: "16.3.6", react: "19.2.8" },
  }));

  const stack = await detectStack(root);
  assert.equal(stack.services.length, 1);
  assert.equal(stack.services[0].relativePath, ".");
  assert.equal(stack.services[0].kind, "node");
  assert.equal(stack.services[0].capabilities.packageManager, "pnpm");
  assert.equal(stack.services[0].capabilities.devPortHint, 3000);
  assert.deepEqual(stack.services[0].capabilities.packageScripts, ["dev", "start", "lint", "build"]);
});

test("detects nested Next.js, Gradle Spring Boot, and Compose infrastructure", async (context) => {
  const root = await fixture(context);
  await write(path.join(root, "frontend", "package.json"), JSON.stringify({
    name: "frontend",
    packageManager: "pnpm@12.3.4",
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: { next: "16.4.0", react: "19.3.0" },
  }));
  await write(path.join(root, "backend", "build.gradle"), "plugins { id 'org.springframework.boot' version '4.1.1' }\n");
  await write(path.join(root, "backend", "gradlew.bat"), "@echo off\r\n");
  await write(path.join(root, "backend", "src", "main", "resources", "application.yaml"), "server:\n  port: 8091\n");
  await write(path.join(root, "infrastructure", "docker-compose.yml"), "services:\n  postgres:\n    image: postgres:17\n");

  const stack = await detectStack(root);
  assert.deepEqual(stack.services.map((service) => [service.relativePath, service.kind]), [
    ["backend", "spring-boot"],
    ["frontend", "node"],
  ]);
  const backend = stack.services[0];
  assert.equal(backend.capabilities.javaBuildTool, "gradle");
  assert.equal(backend.capabilities.hasGradleWrapper, true);
  assert.equal(backend.capabilities.devPortHint, 8091);
  assert.deepEqual(stack.infrastructure.map((item) => item.configurationFile), ["infrastructure/docker-compose.yml"]);
  assert.ok(stack.technologies.some((technology) => technology.name === "Next.js"));
  assert.ok(stack.technologies.some((technology) => technology.name === "Gradle"));
  assert.ok(stack.technologies.some((technology) => technology.name === "Docker Compose"));
});

test("does not absorb services from nested Git repositories or ignored build directories", async (context) => {
  const root = await fixture(context);
  await write(path.join(root, "package.json"), JSON.stringify({ name: "root", scripts: { dev: "node server.js" } }));
  await mkdir(path.join(root, "nested", ".git"), { recursive: true });
  await write(path.join(root, "nested", "package.json"), JSON.stringify({ name: "nested", scripts: { dev: "next dev" }, dependencies: { next: "16" } }));
  await write(path.join(root, "node_modules", "hidden", "package.json"), JSON.stringify({ name: "hidden", scripts: { dev: "next dev" }, dependencies: { next: "16" } }));
  await write(path.join(root, "build", "generated", "build.gradle"), "plugins { id 'org.springframework.boot' version '4' }\n");

  const stack = await detectStack(root);
  assert.deepEqual(stack.services.map((service) => service.name), ["root"]);
});

test("keeps service identifiers stable and distinct by runtime path", async (context) => {
  const root = await fixture(context);
  for (const name of ["web", "admin"]) {
    await write(path.join(root, name, "package.json"), JSON.stringify({ name, scripts: { dev: "next dev" }, dependencies: { next: "16" } }));
  }
  const first = await detectStack(root);
  const second = await detectStack(root);
  assert.deepEqual(first.services.map((service) => service.id), second.services.map((service) => service.id));
  assert.equal(new Set(first.services.map((service) => service.id)).size, 2);
});
