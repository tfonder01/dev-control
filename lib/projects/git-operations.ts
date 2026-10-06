import { execFile } from "node:child_process";

import { parseGitStatus } from "../workspace/git-status.ts";
import type { Repository } from "@/lib/workspace/types";

const GIT_TIMEOUT_MS = 2 * 60_000;
const MAX_CAPTURE_CHARS = 32_000;
const MAX_GIT_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_LENGTH = 200;
const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);
const operationsInFlight = new Set<string>();

export type GitCommitPushRequest = {
  commitMessage: string;
  confirmProtectedBranch: boolean;
  confirmSetUpstream: boolean;
  expectedChangedFiles: string[];
};

export type GitCommitPushResult = {
  status: "success" | "error" | "confirmation-required";
  message: string;
  reason?: "protected-branch" | "missing-upstream";
  commitHash?: string;
  pushed?: boolean;
};

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  unavailable: boolean;
};

export type GitRunner = (repositoryPath: string, args: string[]) => Promise<GitResult>;

function capture(value: string) {
  return value.slice(-MAX_CAPTURE_CHARS);
}

export const runGit: GitRunner = (repositoryPath, args) => new Promise((resolve) => {
  execFile("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    const processError = error as NodeJS.ErrnoException & { code?: string | number } | null;
    resolve({
      ok: !error,
      stdout: capture(stdout ?? ""),
      stderr: capture(stderr ?? ""),
      exitCode: typeof processError?.code === "number" ? processError.code : error ? 1 : 0,
      unavailable: processError?.code === "ENOENT",
    });
  });
});

function safeRemoteName(remote: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote);
}

function validateMessage(rawMessage: string) {
  const commitMessage = rawMessage.trim();
  if (!commitMessage) return { ok: false as const, error: "Enter a commit message." };
  if (commitMessage.length > MAX_COMMIT_MESSAGE_LENGTH) {
    return { ok: false as const, error: `Keep the commit message to ${MAX_COMMIT_MESSAGE_LENGTH} characters or fewer.` };
  }
  if (/[\r\n\0]/.test(commitMessage)) {
    return { ok: false as const, error: "Use a single-line commit message." };
  }
  return { ok: true as const, commitMessage };
}

function output(result: GitResult) {
  return `${result.stdout}\n${result.stderr}`.toLowerCase();
}

function pushFailureMessage(result: GitResult) {
  const detail = output(result);
  if (/non-fast-forward|fetch first|failed to push some refs/.test(detail)) {
    return "Push rejected because the remote branch has changes that must be reconciled separately. DevHub did not pull, merge, rebase, reset, or force-push. The commit remains local.";
  }
  if (/authentication failed|permission denied \(publickey\)|could not read username|terminal prompts disabled|403|access denied/.test(detail)) {
    return "Git authentication failed. Review the repository's existing credential manager or SSH configuration. The commit remains local.";
  }
  if (/remote rejected|pre-receive hook declined|protected branch|hook declined/.test(detail)) {
    return "The remote rejected the push. Its branch protection or server-side hooks were left unchanged. The commit remains local.";
  }
  if (/could not resolve host|failed to connect|connection timed out|network is unreachable|connection was reset/.test(detail)) {
    return "The push could not reach the remote. Check the network and try again; the commit remains local.";
  }
  if (/repository not found|does not appear to be a git repository|no such remote/.test(detail)) {
    return "The configured remote is unavailable. The commit remains local.";
  }
  return "Git push failed. Review the repository in a terminal; the commit remains local. DevHub did not attempt automatic reconciliation or force-push.";
}

async function currentBranch(repository: Repository, runner: GitRunner) {
  const result = await runner(repository.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

async function configuredUpstream(repository: Repository, branch: string, runner: GitRunner) {
  const [remoteResult, mergeResult] = await Promise.all([
    runner(repository.path, ["config", "--get", `branch.${branch}.remote`]),
    runner(repository.path, ["config", "--get", `branch.${branch}.merge`]),
  ]);
  if (!remoteResult.ok || !mergeResult.ok) return null;
  const remote = remoteResult.stdout.trim();
  const upstreamBranch = mergeResult.stdout.trim().replace(/^refs\/heads\//, "");
  if (!safeRemoteName(remote) || !upstreamBranch) return null;
  return { remote, upstreamBranch };
}

async function remoteExists(repository: Repository, remote: string, runner: GitRunner) {
  if (!safeRemoteName(remote)) return false;
  return (await runner(repository.path, ["remote", "get-url", remote])).ok;
}

export async function commitAndPush(
  repository: Repository,
  request: GitCommitPushRequest,
  runner: GitRunner = runGit,
): Promise<GitCommitPushResult> {
  const validatedMessage = validateMessage(request.commitMessage);
  if (!validatedMessage.ok) return { status: "error", message: validatedMessage.error };
  if (operationsInFlight.has(repository.id)) {
    return { status: "error", message: "A Commit & Push operation is already running for this repository." };
  }

  operationsInFlight.add(repository.id);
  try {
    const probe = await runner(repository.path, ["rev-parse", "--is-inside-work-tree"]);
    if (probe.unavailable) return { status: "error", message: "Git is unavailable on this machine." };
    if (!probe.ok || probe.stdout.trim() !== "true") return { status: "error", message: "This indexed path is no longer a Git working tree." };

    const branch = await currentBranch(repository, runner);
    if (!branch) return { status: "error", message: "Commit & Push is unavailable while HEAD is detached." };

    const conflictResult = await runner(repository.path, ["diff", "--name-only", "--diff-filter=U"]);
    if (!conflictResult.ok) return { status: "error", message: "Git could not check for unresolved conflicts." };
    if (conflictResult.stdout.trim()) return { status: "error", message: "Resolve all merge conflicts before committing." };

    const statusResult = await runner(repository.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!statusResult.ok) return { status: "error", message: "Git status could not be read." };
    if (!statusResult.stdout) return { status: "error", message: "There is nothing to commit." };
    const currentChangedFiles = parseGitStatus(statusResult.stdout);
    if (JSON.stringify(currentChangedFiles) !== JSON.stringify(request.expectedChangedFiles)) {
      return { status: "error", message: "The working tree changed after this file list was shown. Refresh Git status and review the updated files before committing." };
    }

    if (PROTECTED_BRANCHES.has(branch) && !request.confirmProtectedBranch) {
      return { status: "confirmation-required", reason: "protected-branch", message: `Confirm that you intend to commit and push directly to ${branch}.` };
    }

    const upstream = await configuredUpstream(repository, branch, runner);
    if (!upstream) {
      if (!(await remoteExists(repository, "origin", runner))) {
        return { status: "error", message: "No upstream is configured and the origin remote is unavailable." };
      }
      if (!request.confirmSetUpstream) {
        return { status: "confirmation-required", reason: "missing-upstream", message: `No upstream is configured for ${branch}. Confirm pushing and setting origin/${branch} as its upstream.` };
      }
    } else if (!(await remoteExists(repository, upstream.remote, runner))) {
      return { status: "error", message: `The configured upstream remote (${upstream.remote}) is unavailable.` };
    }

    const stageResult = await runner(repository.path, ["add", "-A"]);
    if (!stageResult.ok) return { status: "error", message: "Git could not stage all current changes. Nothing was committed or pushed." };

    const stagedResult = await runner(repository.path, ["diff", "--cached", "--quiet"]);
    if (stagedResult.ok) return { status: "error", message: "There is nothing to commit after staging." };

    const commitResult = await runner(repository.path, ["commit", "-m", validatedMessage.commitMessage]);
    if (!commitResult.ok) {
      const detail = output(commitResult);
      const message = /nothing to commit/.test(detail)
        ? "There is nothing to commit. No push was attempted."
        : "Git commit failed. A commit hook may have rejected the change; no push was attempted.";
      return { status: "error", message };
    }

    const hashResult = await runner(repository.path, ["rev-parse", "--short=12", "HEAD"]);
    const commitHash = hashResult.ok ? hashResult.stdout.trim() : undefined;
    const branchAfterCommit = await currentBranch(repository, runner);
    if (branchAfterCommit !== branch) {
      return { status: "error", message: "The current branch changed during the operation. The commit remains local and no push was attempted.", commitHash, pushed: false };
    }

    const pushArgs = upstream
      ? ["push", upstream.remote, branch]
      : ["push", "--set-upstream", "origin", branch];
    const pushResult = await runner(repository.path, pushArgs);
    if (!pushResult.ok) return { status: "error", message: pushFailureMessage(pushResult), commitHash, pushed: false };

    return { status: "success", message: "Committed and pushed.", commitHash, pushed: true };
  } finally {
    operationsInFlight.delete(repository.id);
  }
}

export const gitCommitMessageMaxLength = MAX_COMMIT_MESSAGE_LENGTH;
export const protectedGitBranches = PROTECTED_BRANCHES;
