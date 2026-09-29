import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft, Box, Check, FileCode2, FolderGit2, GitBranch, GitCommitHorizontal, ListTree, Terminal } from "lucide-react";

import { formatActivity, PageShell, RepositoryState, TechnologyBadge } from "@/app/components";
import { ProjectActionsPanel } from "@/app/project-actions-panel";
import { ProjectLinksPanel } from "@/app/project-links-panel";
import { getDependencyStatus } from "@/lib/projects/dependencies";
import { detectProjectLinks } from "@/lib/projects/project-link-detection";
import { getProjectLinks, resolveProjectLinks } from "@/lib/projects/project-links";
import { detectRunningDevServer } from "@/lib/projects/processes";
import { resolveNodeRuntimeProfiles } from "@/lib/projects/node-runtime";
import { resolveSpringRuntime } from "@/lib/projects/runtime-profile";
import { getRepositoryFromSnapshot } from "@/lib/workspace/snapshot";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const repository = await getRepositoryFromSnapshot(id);
  if (!repository) notFound();
  const isNextJs = repository.technologies.some((technology) => technology.name === "Next.js");
  const [devServer, springRuntime, dependencies, nodeRuntimes, projectLinksConfig, detectedProjectLinks] = await Promise.all([
    detectRunningDevServer(repository),
    repository.capabilities.hasSpringBoot ? resolveSpringRuntime(repository).then((runtime) => runtime.status) : null,
    repository.capabilities.hasSpringBoot ? getDependencyStatus(repository) : null,
    isNextJs ? resolveNodeRuntimeProfiles(repository) : null,
    getProjectLinks(repository.id),
    detectProjectLinks(repository),
  ]);

  return (
    <PageShell>
      <header className="site-header detail-header">
        <Link href="/" className="back-link"><ArrowLeft aria-hidden="true" size={16} /> Workspace</Link>
        <span className="header-divider" />
        <span className="detail-product">DevHub</span>
      </header>

      <section className="detail-hero">
        <div className="detail-title-row">
          <div className="project-mark"><FolderGit2 aria-hidden="true" size={24} /></div>
          <div>
            <p className="eyebrow">Repository</p>
            <h1>{repository.name}</h1>
          </div>
        </div>
        <RepositoryState repository={repository} />
      </section>

      <div className="detail-path" title={repository.path}>{repository.path}</div>

      <ProjectLinksPanel
        repositoryId={repository.id}
        initialConfig={projectLinksConfig}
        initialLinks={resolveProjectLinks(projectLinksConfig, detectedProjectLinks)}
      />

      <ProjectActionsPanel
        repositoryId={repository.id}
        technologies={repository.technologies.map((technology) => technology.name)}
        capabilities={repository.capabilities}
        initialDevServer={devServer}
        initialSpringRuntime={springRuntime}
        initialDependencies={dependencies}
        initialNodeRuntimes={nodeRuntimes}
      />

      <section className="detail-grid">
        <div className="detail-card detail-card-wide">
          <div className="card-heading"><Box aria-hidden="true" size={16} /><h2>Repository</h2></div>
          <dl className="data-list">
            <div><dt>Project</dt><dd>{repository.name}</dd></div>
            <div><dt>Stack</dt><dd className="tech-list">{repository.technologies.length > 0 ? repository.technologies.map((technology) => <TechnologyBadge key={technology.name} technology={technology} />) : <span className="muted">Not detected</span>}</dd></div>
            <div><dt>Origin</dt><dd className="break-value">{repository.git.originUrl ?? "No origin configured"}</dd></div>
          </dl>
        </div>

        <div className="detail-card">
          <div className="card-heading"><GitBranch aria-hidden="true" size={16} /><h2>Git</h2></div>
          <dl className="data-list">
            <div><dt>Branch</dt><dd><code>{repository.git.branch}</code></dd></div>
            <div><dt>Working tree</dt><dd><RepositoryState repository={repository} compact /></dd></div>
            <div><dt>Changed files</dt><dd>{repository.git.changedFileCount}</dd></div>
            <div><dt>Last activity</dt><dd>{formatActivity(repository.git.latestCommitTimestamp)}</dd></div>
          </dl>
          {repository.git.error && <p className="inline-error">{repository.git.error}</p>}
        </div>

        <div className="detail-card commit-card">
          <div className="card-heading"><GitCommitHorizontal aria-hidden="true" size={16} /><h2>Latest commit</h2></div>
          {repository.git.latestCommitHash ? (
            <div className="commit-detail">
              <code>{repository.git.latestCommitHash}</code>
              <p>{repository.git.latestCommitSubject}</p>
              {repository.git.latestCommitTimestamp && <time dateTime={repository.git.latestCommitTimestamp}>{new Date(repository.git.latestCommitTimestamp).toLocaleString()}</time>}
            </div>
          ) : <p className="muted">No commit history is available.</p>}
        </div>

        <div className="detail-card">
          <div className="card-heading"><FileCode2 aria-hidden="true" size={16} /><h2>Configuration</h2></div>
          {repository.configurationFiles.length > 0 ? (
            <ul className="file-list">{repository.configurationFiles.map((file) => <li key={file}><Check aria-hidden="true" size={13} />{file}</li>)}</ul>
          ) : <p className="muted">No recognized configuration markers.</p>}
        </div>

        <div className="detail-card">
          <div className="card-heading"><Terminal aria-hidden="true" size={16} /><h2>Commands</h2></div>
          {repository.commands.length > 0 ? (
            <ul className="command-list">{repository.commands.map((command) => <li key={`${command.label}-${command.command}`}><span>{command.label}</span><code>{command.command}</code></li>)}</ul>
          ) : <p className="muted">No common project commands detected.</p>}
          <p className="card-note">Detected commands are informational. DevHub runs only the allowlisted actions above.</p>
        </div>

        <div className="detail-card detail-card-full">
          <div className="card-heading"><ListTree aria-hidden="true" size={16} /><h2>Changed files</h2><span className="card-count">{repository.git.changedFileCount}</span></div>
          {repository.git.changedFiles.length > 0 ? (
            <ul className="changed-list">
              {repository.git.changedFiles.slice(0, 50).map((file) => <li key={file}><span className="change-dot" /><code>{file}</code></li>)}
              {repository.git.changedFiles.length > 50 && <li className="muted">+ {repository.git.changedFiles.length - 50} more files</li>}
            </ul>
          ) : <div className="clean-message"><Check aria-hidden="true" size={16} /> Working tree is clean.</div>}
        </div>
      </section>
    </PageShell>
  );
}
