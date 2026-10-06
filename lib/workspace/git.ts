import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseGitStatus } from "./git-status";
import type { GitMetadata } from "./types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 8_000;

async function runGitRaw(repositoryPath: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });

  return stdout;
}

async function runGit(repositoryPath: string, args: string[]) {
  return (await runGitRaw(repositoryPath, args)).trim();
}

function toGithubUrl(remote: string | null) {
  if (!remote) return null;

  const trimmed = remote.trim().replace(/\.git$/, "");
  if (/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+$/i.test(trimmed)) {
    return trimmed;
  }

  const sshMatch = trimmed.match(/^git@github\.com:([\w.-]+\/[\w.-]+)$/i);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;

  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([\w.-]+\/[\w.-]+)$/i);
  if (sshUrlMatch) return `https://github.com/${sshUrlMatch[1]}`;

  return null;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.split("\n")[0];
  return "Git metadata could not be read.";
}

export async function readGitMetadata(repositoryPath: string): Promise<GitMetadata> {
  const [statusResult, branchResult, logResult, remoteResult, conflictResult] = await Promise.allSettled([
    runGitRaw(repositoryPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(repositoryPath, ["branch", "--show-current"]),
    runGit(repositoryPath, ["log", "-1", "--format=%h%x00%s%x00%cI"]),
    runGit(repositoryPath, ["config", "--get", "remote.origin.url"]),
    runGit(repositoryPath, ["diff", "--name-only", "--diff-filter=U"]),
  ]);

  const errors = [statusResult, branchResult, logResult]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => errorMessage(result.reason));

  const status = statusResult.status === "fulfilled" ? parseGitStatus(statusResult.value) : [];
  const logParts = logResult.status === "fulfilled" ? logResult.value.split("\0") : [];
  let branch = branchResult.status === "fulfilled" ? branchResult.value : "";

  if (!branch && logParts[0]) branch = `detached @ ${logParts[0]}`;
  if (!branch) branch = "No commits yet";

  const hasLocalBranch = branch !== "No commits yet" && !branch.startsWith("detached @");
  const upstreamResult = hasLocalBranch
    ? await Promise.allSettled([
        runGit(repositoryPath, ["config", "--get", `branch.${branch}.remote`]),
        runGit(repositoryPath, ["config", "--get", `branch.${branch}.merge`]),
        runGit(repositoryPath, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
      ])
    : [];
  const upstreamRemote = upstreamResult[0]?.status === "fulfilled" && upstreamResult[0].value
    ? upstreamResult[0].value
    : null;
  const upstreamMerge = upstreamResult[1]?.status === "fulfilled" && upstreamResult[1].value
    ? upstreamResult[1].value
    : null;
  const counts = upstreamResult[2]?.status === "fulfilled"
    ? upstreamResult[2].value.split(/\s+/).map(Number)
    : [];

  const originUrl = remoteResult.status === "fulfilled" && remoteResult.value
    ? remoteResult.value
    : null;

  return {
    branch,
    isDirty: status.length > 0,
    changedFileCount: status.length,
    changedFiles: status,
    hasConflicts: conflictResult.status === "fulfilled" && Boolean(conflictResult.value),
    upstreamRemote,
    upstreamBranch: upstreamMerge?.replace(/^refs\/heads\//, "") ?? null,
    ahead: Number.isFinite(counts[0]) ? counts[0] : null,
    behind: Number.isFinite(counts[1]) ? counts[1] : null,
    latestCommitHash: logParts[0] || null,
    latestCommitSubject: logParts[1] || null,
    latestCommitTimestamp: logParts[2] || null,
    originUrl,
    githubUrl: toGithubUrl(originUrl),
    error: errors.length > 0 ? errors[0] : null,
  };
}
