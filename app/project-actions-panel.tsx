"use client";

import { useState, useTransition } from "react";
import { Code2, ExternalLink, FolderOpen, LoaderCircle, Play, Square, TestTube2, Wrench } from "lucide-react";

import { runRepositoryAction } from "./actions";
import type { DevServerStatus, RepositoryAction, RepositoryActionResult } from "@/lib/projects/action-types";
import type { ProjectCapabilities } from "@/lib/workspace/types";

type Props = {
  repositoryId: string;
  githubUrl: string | null;
  technologies: string[];
  capabilities: ProjectCapabilities;
  initialDevServer: DevServerStatus;
};

const actionLabels: Record<RepositoryAction, string> = {
  "open-cursor": "Open in Cursor",
  "open-intellij": "Open in IntelliJ",
  "open-explorer": "Explorer",
  "open-terminal": "Terminal",
  "start-dev": "Start Dev",
  "stop-dev": "Stop Dev",
  "run-test": "Run Tests",
  "run-lint": "Run Lint",
  "run-build": "Run Build",
  "run-verify": "Maven Verify",
};

function ActionButton({ action, activeAction, onRun, icon, label }: {
  action: RepositoryAction;
  activeAction: RepositoryAction | null;
  onRun: (action: RepositoryAction) => void;
  icon: React.ReactNode;
  label?: string;
}) {
  const pending = activeAction === action;
  const actionLabel = label ?? actionLabels[action];
  return (
    <button type="button" className="project-action-button" disabled={activeAction !== null} onClick={() => onRun(action)}>
      {pending ? <LoaderCircle className="spin" aria-hidden="true" size={14} /> : icon}
      {pending ? `${actionLabel}...` : actionLabel}
    </button>
  );
}

export function ProjectActionsPanel({ repositoryId, githubUrl, technologies, capabilities, initialDevServer }: Props) {
  const [isPending, startTransition] = useTransition();
  const [activeAction, setActiveAction] = useState<RepositoryAction | null>(null);
  const [result, setResult] = useState<RepositoryActionResult | null>(null);
  const [devServer, setDevServer] = useState(initialDevServer);

  const run = (action: RepositoryAction) => {
    setActiveAction(action);
    setResult(null);
    startTransition(async () => {
      try {
        const nextResult = await runRepositoryAction(repositoryId, action);
        setResult(nextResult);
        if (nextResult.devServer) setDevServer(nextResult.devServer);
      } catch {
        setResult({ status: "error", message: "The action could not be completed." });
      } finally {
        setActiveAction(null);
      }
    });
  };

  const isSpringBoot = capabilities.hasSpringBoot;
  const canStartDev = isSpringBoot || (capabilities.packageScripts.includes("dev") && Boolean(capabilities.packageManager));
  const canStopDev = devServer.ownedByDevHub && (devServer.state === "running" || devServer.state === "starting");
  const canTest = capabilities.packageScripts.includes("test") || capabilities.hasMavenWrapper;
  const hasChecks = canTest || capabilities.packageScripts.includes("lint") || capabilities.packageScripts.includes("build") || capabilities.hasMavenWrapper;
  const isJavaProject = isSpringBoot || capabilities.hasMavenWrapper
    || technologies.some((technology) => technology === "Java" || technology === "Maven" || technology === "Spring Boot");
  const effectiveActiveAction = isPending ? activeAction : null;
  const runtimeLabel = devServer.state === "running"
    ? `Running${devServer.port ? ` · localhost:${devServer.port}` : ""}`
    : devServer.state === "port-in-use"
      ? `Running externally${devServer.port ? ` · localhost:${devServer.port}` : ""}`
      : devServer.state === "starting"
        ? "Starting..."
        : devServer.state === "failed" ? "Failed" : "Stopped";

  return (
    <section className="project-actions" aria-labelledby="project-actions-title">
      <div className="project-actions-heading">
        <div>
          <p className="eyebrow">Operate</p>
          <h2 id="project-actions-title">Actions</h2>
        </div>
        <span className={`runtime-badge runtime-${devServer.state}`}>
          <span aria-hidden="true" /> {runtimeLabel}
        </span>
      </div>

      <div className="project-action-groups">
        <div className="action-group">
          <h3>Quick actions</h3>
          <div className="action-buttons">
            {isJavaProject && <ActionButton action="open-intellij" activeAction={effectiveActiveAction} onRun={run} icon={<Code2 aria-hidden="true" size={14} />} />}
            <ActionButton action="open-cursor" activeAction={effectiveActiveAction} onRun={run} icon={<Wrench aria-hidden="true" size={14} />} />
            <ActionButton action="open-explorer" activeAction={effectiveActiveAction} onRun={run} icon={<FolderOpen aria-hidden="true" size={14} />} />
            {githubUrl && <a className="project-action-button" href={githubUrl} target="_blank" rel="noreferrer">GitHub <ExternalLink aria-hidden="true" size={13} /></a>}
          </div>
        </div>

        <div className="action-group">
          <h3>Development</h3>
          {canStartDev ? (
            <>
              <div className="action-buttons">
                {canStopDev
                  ? <ActionButton action="stop-dev" activeAction={effectiveActiveAction} onRun={run} icon={<Square aria-hidden="true" size={13} />} label={isSpringBoot ? "Stop Backend" : undefined} />
                  : <ActionButton action="start-dev" activeAction={effectiveActiveAction} onRun={run} icon={<Play aria-hidden="true" size={13} />} label={isSpringBoot ? "Start Backend" : undefined} />}
                {devServer.url && <a className="project-action-button" href={devServer.url} target="_blank" rel="noreferrer">{isSpringBoot ? "Open Local API" : "Open Local App"} <ExternalLink aria-hidden="true" size={13} /></a>}
              </div>
              <p className="runtime-copy">{devServer.url ? `Local: ${devServer.url}` : devServer.message}</p>
              {devServer.state === "port-in-use" && <p className="ownership-note">Not owned by DevHub; Stop Dev is unavailable.</p>}
            </>
          ) : <p className="action-empty">No supported development runtime detected.</p>}
        </div>

        <div className="action-group">
          <h3>Checks</h3>
          {hasChecks ? (
            <div className="action-buttons">
              {canTest && <ActionButton action="run-test" activeAction={effectiveActiveAction} onRun={run} icon={<TestTube2 aria-hidden="true" size={14} />} />}
              {capabilities.packageScripts.includes("lint") && <ActionButton action="run-lint" activeAction={effectiveActiveAction} onRun={run} icon={<TestTube2 aria-hidden="true" size={14} />} />}
              {capabilities.packageScripts.includes("build") && <ActionButton action="run-build" activeAction={effectiveActiveAction} onRun={run} icon={<TestTube2 aria-hidden="true" size={14} />} />}
              {capabilities.hasMavenWrapper && <ActionButton action="run-verify" activeAction={effectiveActiveAction} onRun={run} icon={<TestTube2 aria-hidden="true" size={14} />} />}
            </div>
          ) : <p className="action-empty">No allowlisted checks detected.</p>}
        </div>
      </div>

      {result && (
        <div className={`action-result action-result-${result.status}`} role="status" aria-live="polite">
          <div>
            <strong>{result.message}</strong>
            {(result.durationMs !== undefined || result.exitCode !== undefined) && (
              <span>{result.durationMs !== undefined ? `${(result.durationMs / 1000).toFixed(1)}s` : ""}{result.exitCode !== undefined ? ` · exit ${result.exitCode ?? "n/a"}` : ""}</span>
            )}
          </div>
          {result.output && <details><summary>Recent output</summary><pre>{result.output}</pre></details>}
        </div>
      )}
    </section>
  );
}
