import "server-only";

import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ProjectType } from "./validation";

const execFileAsync = promisify(execFile);
const COMMAND_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

export type ProjectSetupOptions = {
  addReadme: boolean;
  addAgents: boolean;
  addClaude: boolean;
  useEngineeringStandards: boolean;
};

async function executeProgram(file: string, args: string[], cwd: string, timeout: number) {
  await execFileAsync(file, args, {
    cwd,
    env: COMMAND_ENV,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
}

async function ensureRemoteIsEmpty(cloneUrl: string, workspaceRoot: string) {
  const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", "--tags", "--", cloneUrl], {
    cwd: workspaceRoot,
    env: COMMAND_ENV,
    encoding: "utf8",
    maxBuffer: 512 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });

  if (stdout.trim()) {
    throw new Error("This GitHub repository already has content. Choose “Existing repo only” to clone it without scaffolding.");
  }
}

export async function cloneRepository(cloneUrl: string, destination: string, workspaceRoot: string) {
  await executeProgram("git", ["clone", "--origin", "origin", "--", cloneUrl, destination], workspaceRoot, 120_000);
}

export async function scaffoldNextApp(destination: string) {
  await executeProgram(
    "pnpm.cmd",
    [
      "create", "next-app", ".", "--ts", "--tailwind", "--eslint", "--app",
      "--use-pnpm", "--no-src-dir", "--import-alias", "@/*", "--no-agents-md",
      "--disable-git", "--yes",
    ],
    destination,
    10 * 60_000,
  );
}

async function writeIfMissing(filePath: string, content: string, skipped: string[]) {
  try {
    await writeFile(/* turbopackIgnore: true */ filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      skipped.push(path.basename(filePath));
      return;
    }
    throw error;
  }
}

async function addOptionalProjectFiles(destination: string, projectName: string, options: ProjectSetupOptions) {
  const skipped: string[] = [];
  const standardsText = options.useEngineeringStandards
    ? "\nFollow the shared SentryPoint engineering standards: https://github.com/tfonder01/engineering-standards\nKeep project-specific commands, routes, and release facts in this repository.\n"
    : "";

  if (options.addReadme) {
    await writeIfMissing(path.join(destination, "README.md"), `# ${projectName}\n`, skipped);
  }
  if (options.addAgents || options.useEngineeringStandards) {
    await writeIfMissing(
      path.join(destination, "AGENTS.md"),
      `# Project guidance\n\nKeep changes narrow, test the affected boundary, and do not commit or deploy without explicit approval.${standardsText}`,
      skipped,
    );
  }
  if (options.addClaude) {
    await writeIfMissing(path.join(destination, "CLAUDE.md"), "Follow the repository guidance in AGENTS.md.\n", skipped);
  }

  return skipped;
}

export async function initializeProject({
  cloneUrl,
  destination,
  workspaceRoot,
  projectName,
  projectType,
  setup,
}: {
  cloneUrl: string;
  destination: string;
  workspaceRoot: string;
  projectName: string;
  projectType: Exclude<ProjectType, "spring-boot">;
  setup: ProjectSetupOptions;
}) {
  let destinationOwned = false;

  try {
    if (projectType === "nextjs" || projectType === "empty") {
      await ensureRemoteIsEmpty(cloneUrl, workspaceRoot);
    }

    await mkdir(/* turbopackIgnore: true */ destination);
    destinationOwned = true;
    await cloneRepository(cloneUrl, destination, workspaceRoot);

    if (projectType === "nextjs") await scaffoldNextApp(destination);
    const skippedFiles = await addOptionalProjectFiles(destination, projectName, setup);
    return { skippedFiles };
  } catch (error) {
    if (destinationOwned) {
      await rm(/* turbopackIgnore: true */ destination, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function prepareDestinationCategory(categoryPath: string, workspaceRoot: string) {
  await mkdir(/* turbopackIgnore: true */ categoryPath, { recursive: true });
  const [canonicalRoot, canonicalCategory] = await Promise.all([
    realpath(/* turbopackIgnore: true */ workspaceRoot),
    realpath(/* turbopackIgnore: true */ categoryPath),
  ]);
  const relative = path.relative(canonicalRoot, canonicalCategory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The destination category resolves outside DEV_CONTROL_ROOT.");
  }
}
