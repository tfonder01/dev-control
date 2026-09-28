import { connection } from "next/server";
import { FolderSearch, GitCommitHorizontal, TerminalSquare } from "lucide-react";

import { getGreeting } from "@/lib/dashboard/greeting";
import { getWorkspaceSnapshot } from "@/lib/workspace/snapshot";
import { NewProjectDialog } from "./new-project-dialog";
import { PageShell } from "./components";
import { RefreshWorkspaceButton } from "./refresh-workspace-button";
import { RepositoryBrowser } from "./repository-browser";

export default async function Home() {
  await connection();
  const workspace = await getWorkspaceSnapshot();
  const modifiedCount = workspace.repositories.filter((repository) => repository.git.isDirty).length;
  const cleanCount = workspace.repositories.filter((repository) => !repository.git.isDirty && !repository.git.error).length;
  const now = new Date();
  const categories = Array.from(new Set(
    workspace.repositories
      .map((repository) => repository.relativePath.split(/[\\/]/)[0])
      .filter((category) => category && category !== "."),
  )).sort((a, b) => a.localeCompare(b));

  return (
    <PageShell>
      <header className="site-header">
        <div className="brand-mark"><TerminalSquare aria-hidden="true" size={18} /></div>
        <div>
          <div className="brand-name">Dev Control</div>
          <div className="brand-kicker"><span className="live-dot" /> Local workspace</div>
        </div>
        {!workspace.error && <div className="header-action"><NewProjectDialog key={workspace.scannedAt} categories={categories} /></div>}
      </header>

      <section className="dashboard-heading">
        <div>
          <h1>{getGreeting(now.getHours())}, Tyon.</h1>
          <p>{workspace.repositories.length} repos <span>·</span> {modifiedCount} modified <span>·</span> {cleanCount} clean</p>
        </div>
        <div className="scan-time">
          <span>Last scan</span>
          <time dateTime={workspace.scannedAt}>{new Date(workspace.scannedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</time>
          <small>{(workspace.scanDurationMs / 1000).toFixed(1)}s scan</small>
        </div>
      </section>

      {workspace.error ? (
        <section className="setup-state">
          <div className="empty-icon"><FolderSearch aria-hidden="true" size={24} /></div>
          <div>
            <h2>Workspace unavailable</h2>
            <p>{workspace.error}</p>
            <code>DEV_CONTROL_ROOT=C:\path\to\your\projects</code>
          </div>
        </section>
      ) : (
        <>
          <div className="workspace-path">
            <span>DEV_CONTROL_ROOT</span>
            <code title={workspace.root ?? undefined}>{workspace.root}</code>
          </div>

          <section className="repository-section">
            <div className="section-heading">
              <div><p className="eyebrow">Workspace</p><h2>Repositories</h2></div>
              <div className="section-actions"><span>{workspace.repositories.length} indexed</span><RefreshWorkspaceButton /></div>
            </div>

            {workspace.repositories.length === 0 ? (
              <div className="empty-state">
                <FolderSearch aria-hidden="true" size={28} />
                <h3>No Git repositories found</h3>
                <p>Check the configured root or initialize your first project.</p>
              </div>
            ) : <RepositoryBrowser repositories={workspace.repositories} />}
          </section>

          {workspace.warnings.length > 0 && (
            <details className="scan-warnings">
              <summary>{workspace.warnings.length} scan warning{workspace.warnings.length === 1 ? "" : "s"}</summary>
              <ul>{workspace.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </details>
          )}
        </>
      )}

      <footer><GitCommitHorizontal aria-hidden="true" size={14} /> Read-only workspace inspection</footer>
    </PageShell>
  );
}
