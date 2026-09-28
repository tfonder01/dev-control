import { AlertTriangle, Check, CircleDot, GitBranch, GitCommitHorizontal } from "lucide-react";

import type { Repository, Technology } from "@/lib/workspace/types";

export function TechnologyBadge({ technology }: { technology: Technology }) {
  return <span className={`tech-badge tech-${technology.tone}`}>{technology.name}</span>;
}

export function RepositoryState({ repository, compact = false }: { repository: Repository; compact?: boolean }) {
  if (repository.git.error) {
    return (
      <span className="repo-state state-error" title={repository.git.error}>
        <AlertTriangle aria-hidden="true" size={13} /> Git unavailable
      </span>
    );
  }

  if (repository.git.isDirty) {
    return (
      <span className="repo-state state-modified">
        <CircleDot aria-hidden="true" size={13} />
        {compact ? "Modified" : `${repository.git.changedFileCount} changed`}
      </span>
    );
  }

  return (
    <span className="repo-state state-clean">
      <Check aria-hidden="true" size={13} /> Clean
    </span>
  );
}

export function BranchLabel({ branch }: { branch: string }) {
  return (
    <span className="meta-label" title={branch}>
      <GitBranch aria-hidden="true" size={14} />
      <span>{branch}</span>
    </span>
  );
}

export function CommitLabel({ repository }: { repository: Repository }) {
  if (!repository.git.latestCommitHash) return <span className="muted">No commits yet</span>;

  return (
    <span className="commit-label" title={repository.git.latestCommitSubject ?? undefined}>
      <GitCommitHorizontal aria-hidden="true" size={14} />
      <code>{repository.git.latestCommitHash}</code>
      <span>{repository.git.latestCommitSubject}</span>
    </span>
  );
}

export function formatActivity(timestamp: string | null) {
  if (!timestamp) return "No activity";
  const date = new Date(timestamp);
  const elapsed = Date.now() - date.getTime();
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <main className="page-container">{children}</main>
    </div>
  );
}
