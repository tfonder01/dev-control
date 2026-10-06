"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, GitCommitHorizontal, LoaderCircle, RefreshCw } from "lucide-react";

import { commitAndPushAction, refreshRepositoryGitAction } from "./actions";
import type { GitCommitPushResult } from "@/lib/projects/git-operations";
import type { GitMetadata } from "@/lib/workspace/types";

const MAX_COMMIT_MESSAGE_LENGTH = 200;
const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);

type Props = {
  repositoryId: string;
  initialGit: GitMetadata;
};

export function GitActionsPanel({ repositoryId, initialGit }: Props) {
  const router = useRouter();
  const [git, setGit] = useState(initialGit);
  const [message, setMessage] = useState("");
  const [confirmProtected, setConfirmProtected] = useState(false);
  const [confirmUpstream, setConfirmUpstream] = useState(false);
  const [result, setResult] = useState<GitCommitPushResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const [operation, setOperation] = useState<"commit" | "refresh" | null>(null);

  const isProtected = PROTECTED_BRANCHES.has(git.branch);
  const needsUpstream = !git.upstreamRemote || !git.upstreamBranch;
  const canSubmit = git.isDirty && !git.hasConflicts && message.trim().length > 0
    && message.trim().length <= MAX_COMMIT_MESSAGE_LENGTH
    && (!isProtected || confirmProtected)
    && (!needsUpstream || confirmUpstream);

  const refreshStatus = async () => {
    setOperation("refresh");
    try {
      const nextGit = await refreshRepositoryGitAction(repositoryId);
      if (nextGit) {
        setGit(nextGit);
        router.refresh();
      } else {
        setResult({ status: "error", message: "Git status could not be refreshed." });
      }
    } catch {
      setResult({ status: "error", message: "Git status could not be refreshed." });
    } finally {
      setOperation(null);
    }
  };

  const submit = () => {
    setOperation("commit");
    setResult(null);
    startTransition(async () => {
      try {
        const nextResult = await commitAndPushAction(repositoryId, {
          commitMessage: message,
          confirmProtectedBranch: confirmProtected,
          confirmSetUpstream: confirmUpstream,
          expectedChangedFiles: git.changedFiles,
        });
        setResult(nextResult);
        if (nextResult.status !== "confirmation-required") {
          const nextGit = await refreshRepositoryGitAction(repositoryId);
          if (nextGit) setGit(nextGit);
          if (nextResult.status === "success") setMessage("");
          router.refresh();
        }
      } catch {
        setResult({ status: "error", message: "Commit & Push could not be completed." });
      } finally {
        setOperation(null);
      }
    });
  };

  if (!git.isDirty && !result) return null;

  return (
    <section className="git-actions-card" aria-labelledby="git-actions-title">
      <div className="git-actions-heading">
        <div>
          <p className="eyebrow">Git workflow</p>
          <h2 id="git-actions-title"><GitCommitHorizontal aria-hidden="true" size={16} /> Commit &amp; Push</h2>
        </div>
        <button type="button" className="git-refresh-button" disabled={operation !== null || isPending} onClick={refreshStatus}>
          {operation === "refresh" ? <LoaderCircle className="spin" aria-hidden="true" size={13} /> : <RefreshCw aria-hidden="true" size={13} />}
          Refresh status
        </button>
      </div>

      {git.isDirty ? (
        <div className="git-actions-layout">
          <div className="git-change-summary">
            <div className="git-facts">
              <span>Branch <code>{git.branch}</code></span>
              <span>{git.changedFileCount} changed {git.changedFileCount === 1 ? "file" : "files"}</span>
              <span>{needsUpstream ? "No upstream" : `${git.upstreamRemote}/${git.upstreamBranch}`}</span>
              {git.ahead !== null && git.behind !== null && <span>{git.ahead} ahead / {git.behind} behind</span>}
            </div>
            <p className="git-stage-note"><strong>Commit all current changes</strong> uses the equivalent of <code>git add -A</code> only after you submit.</p>
            <ul className="git-change-list" aria-label="Files that will be included">
              {git.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}
            </ul>
          </div>

          <div className="git-commit-form">
            {git.hasConflicts && <p className="git-warning"><AlertTriangle aria-hidden="true" size={14} /> Resolve all merge conflicts before committing.</p>}
            {isProtected && (
              <label className="git-confirmation git-protected-warning">
                <input type="checkbox" checked={confirmProtected} onChange={(event) => setConfirmProtected(event.target.checked)} />
                <span><strong>You are about to push directly to {git.branch}.</strong> Confirm this is intentional.</span>
              </label>
            )}
            {needsUpstream && (
              <label className="git-confirmation">
                <input type="checkbox" checked={confirmUpstream} onChange={(event) => setConfirmUpstream(event.target.checked)} />
                <span><strong>No upstream is configured for this branch.</strong> Push and set upstream to origin/{git.branch}.</span>
              </label>
            )}
            <label className="git-message-field">
              <span>Commit message</span>
              <input
                type="text"
                value={message}
                maxLength={MAX_COMMIT_MESSAGE_LENGTH}
                placeholder="Describe the change"
                autoComplete="off"
                disabled={operation !== null || isPending}
                onChange={(event) => setMessage(event.target.value)}
              />
              <small>{message.length}/{MAX_COMMIT_MESSAGE_LENGTH}</small>
            </label>
            <button type="button" className="git-submit-button" disabled={!canSubmit || operation !== null || isPending} onClick={submit}>
              {operation === "commit" || isPending ? <LoaderCircle className="spin" aria-hidden="true" size={14} /> : <GitCommitHorizontal aria-hidden="true" size={14} />}
              Commit &amp; Push
            </button>
            {(operation === "commit" || isPending) && (
              <div className="git-progress" role="status" aria-label="Commit and push in progress">
                <span>Staging...</span><span>Committing...</span><span>Pushing...</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="git-clean-result"><Check aria-hidden="true" size={15} /> Working tree is clean.</div>
      )}

      {result && (
        <div className={`git-operation-result git-operation-${result.status}`} role="status">
          <strong>{result.message}</strong>
          {result.commitHash && <span>Commit <code>{result.commitHash}</code>{result.pushed ? " is on the configured remote." : " remains local."}</span>}
        </div>
      )}
    </section>
  );
}
