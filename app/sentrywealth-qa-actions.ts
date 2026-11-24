"use server";

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { qaCommand, qaReports, SENTRYWEALTH_REPOSITORY_ID, SentryWealthQa, type QaReport, type QaSuite } from "@/lib/projects/sentrywealth-qa";
import { discoverPowerShell, launchWindowsTool } from "@/lib/projects/windows-tools";
import { getRepositoryFromSnapshot } from "@/lib/workspace/snapshot";

const runtime = globalThis as typeof globalThis & { devHubSentryWealthQa?: SentryWealthQa };
const qa = runtime.devHubSentryWealthQa ??= new SentryWealthQa();

async function repositoryForQa(repositoryId: string) {
  if (process.platform !== "win32" || repositoryId !== SENTRYWEALTH_REPOSITORY_ID) return null;
  return getRepositoryFromSnapshot(repositoryId);
}

async function existingFile(root: string, relativePath: string) {
  try {
    const [resolvedRoot, file] = await Promise.all([realpath(root), realpath(path.join(root, relativePath))]);
    const relative = path.relative(resolvedRoot, file);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || !(await stat(file)).isFile()) return null;
    return file;
  } catch {
    return null;
  }
}

export async function getSentryWealthQa(repositoryId: string) {
  const repository = await repositoryForQa(repositoryId);
  if (!repository) return null;
  const reports = await Promise.all((Object.keys(qaReports) as QaReport[]).map(async (id) => (
    await existingFile(repository.path, `frontend/playwright-report/${qaReports[id]}/index.html`) ? id : null
  )));
  return { run: qa.status(), reports: reports.filter((report) => report !== null) };
}

export async function startSentryWealthQa(repositoryId: string, suite: QaSuite) {
  const repository = await repositoryForQa(repositoryId);
  if (!repository) return { error: "SentryWealth QA is unavailable for this repository." };
  try {
    await qa.start(suite, async () => {
      const [script, powershell] = await Promise.all([
        existingFile(repository.path, "scripts/qa.ps1"), discoverPowerShell(),
      ]);
      if (!script) throw new Error("SentryWealth’s scripts/qa.ps1 could not be found.");
      if (!powershell.candidate) throw new Error("Windows PowerShell could not be found.");
      return qaCommand(powershell.candidate.executable, repository.path, path.resolve("scripts/run-sentrywealth-qa.ps1"), suite);
    });
    return { run: qa.status() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "SentryWealth QA could not start." };
  }
}

export async function cancelSentryWealthQa(repositoryId: string, runId: number) {
  if (!await repositoryForQa(repositoryId)) return { error: "SentryWealth QA is unavailable for this repository." };
  qa.cancel(runId);
  return { run: qa.status() };
}

export async function openSentryWealthQaReport(repositoryId: string, reportId: QaReport) {
  const repository = await repositoryForQa(repositoryId);
  if (!repository || !Object.hasOwn(qaReports, reportId)) return { error: "This QA report is unavailable." };
  const report = await existingFile(repository.path, `frontend/playwright-report/${qaReports[reportId]}/index.html`);
  if (!report) return { error: "This QA report is unavailable." };
  try {
    await launchWindowsTool({ executable: "explorer.exe", source: "Windows" }, [report], repository.path);
    return {};
  } catch {
    return { error: "The Playwright report could not be opened." };
  }
}
