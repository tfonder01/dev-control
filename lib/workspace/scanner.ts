import "server-only";

import { createHash } from "node:crypto";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";

import { readGitMetadata } from "./git";
import { detectStack } from "./stack-detector";
import type { Repository, WorkspaceScanResult } from "./types";

const MAX_SCAN_DEPTH = 6;
const MAX_DIRECTORIES = 20_000;
const METADATA_CONCURRENCY = 6;
const SKIPPED_DIRECTORIES = new Set([
  ".next", ".idea", ".vscode", ".gradle", ".mvn", ".turbo", ".cache",
  "node_modules", "target", "build", "dist", "coverage", "out", "vendor",
  "venv", ".venv", "__pycache__",
]);

function repositoryId(relativePath: string) {
  return createHash("sha256").update(relativePath.toLowerCase()).digest("base64url").slice(0, 16);
}

async function isRepository(directoryPath: string) {
  try {
    const gitMarker = await stat(path.join(/* turbopackIgnore: true */ directoryPath, ".git"));
    return gitMarker.isDirectory() || gitMarker.isFile();
  } catch {
    return false;
  }
}

async function discoverRepositoryPaths(root: string, warnings: string[]) {
  const repositories: string[] = [];
  const queue = [{ directoryPath: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_DIRECTORIES) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;

    if (await isRepository(current.directoryPath)) repositories.push(current.directoryPath);
    if (current.depth >= MAX_SCAN_DEPTH) continue;

    try {
      const directory = await opendir(current.directoryPath);
      for await (const entry of directory) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name) || entry.name === ".git") continue;
        queue.push({ directoryPath: path.join(/* turbopackIgnore: true */ current.directoryPath, entry.name), depth: current.depth + 1 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : "Access denied";
      warnings.push(`Skipped ${current.directoryPath}: ${message}`);
    }
  }

  if (visited >= MAX_DIRECTORIES) warnings.push(`Scan stopped after ${MAX_DIRECTORIES.toLocaleString()} directories.`);
  return repositories;
}

async function mapWithConcurrency<T, R>(items: T[], worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, items.length) }, runWorker));
  return results;
}

function sortRepositories(repositories: Repository[]) {
  return repositories.sort((a, b) => {
    if (a.git.isDirty !== b.git.isDirty) return a.git.isDirty ? -1 : 1;
    const aTime = a.git.latestCommitTimestamp ? Date.parse(a.git.latestCommitTimestamp) : 0;
    const bTime = b.git.latestCommitTimestamp ? Date.parse(b.git.latestCommitTimestamp) : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });
}

export async function scanWorkspace(): Promise<WorkspaceScanResult> {
  const configuredRoot = process.env.DEV_CONTROL_ROOT?.trim();
  const scannedAt = new Date().toISOString();

  if (!configuredRoot) {
    return { root: null, repositories: [], warnings: [], error: "DEV_CONTROL_ROOT is not configured.", scannedAt };
  }

  const root = path.resolve(configuredRoot);
  try {
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) throw new Error("Configured path is not a directory.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Path is unavailable.";
    return { root, repositories: [], warnings: [], error: `Cannot scan DEV_CONTROL_ROOT: ${detail}`, scannedAt };
  }

  const warnings: string[] = [];
  const repositoryPaths = await discoverRepositoryPaths(root, warnings);
  const repositories = await mapWithConcurrency(repositoryPaths, async (repositoryPath): Promise<Repository> => {
    const relativePath = path.relative(root, repositoryPath) || ".";
    const [stack, git] = await Promise.all([detectStack(repositoryPath), readGitMetadata(repositoryPath)]);

    return {
      id: repositoryId(relativePath),
      name: path.basename(repositoryPath),
      path: repositoryPath,
      relativePath,
      technologies: stack.technologies,
      configurationFiles: stack.configurationFiles,
      commands: stack.commands,
      git,
    };
  });

  return { root, repositories: sortRepositories(repositories), warnings, error: null, scannedAt };
}
