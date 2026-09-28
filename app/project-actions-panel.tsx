"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Check, Code2, ExternalLink, FolderOpen, LoaderCircle, Play, Square, TestTube2, Wrench, X } from "lucide-react";

import { runRepositoryAction } from "./actions";
import type { DependencyRuntimeStatus, DevServerStatus, NodeLaunchMode, NodeRuntimeProfiles, RepositoryAction, RepositoryActionResult, SpringRuntimeStatus } from "@/lib/projects/action-types";
import type { ProjectCapabilities } from "@/lib/workspace/types";

type Props = {
  repositoryId: string;
  githubUrl: string | null;
  technologies: string[];
  capabilities: ProjectCapabilities;
  initialDevServer: DevServerStatus;
  initialSpringRuntime: SpringRuntimeStatus | null;
  initialDependencies: DependencyRuntimeStatus | null;
  initialNodeRuntimes: NodeRuntimeProfiles | null;
};

const actionLabels: Record<RepositoryAction, string> = {
  "open-cursor": "Open in Cursor",
  "open-intellij": "Open in IntelliJ",
  "open-explorer": "Explorer",
  "open-terminal": "Terminal",
  "start-dev": "Start Dev",
  "start-preview": "Build & Start Preview",
  "stop-dev": "Stop Dev",
  "start-dependencies": "Start Dependencies",
  "stop-dependencies": "Stop Dependencies",
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

export function ProjectActionsPanel({ repositoryId, githubUrl, technologies, capabilities, initialDevServer, initialSpringRuntime, initialDependencies, initialNodeRuntimes }: Props) {
  const [isPending, startTransition] = useTransition();
  const [activeAction, setActiveAction] = useState<RepositoryAction | null>(null);
  const [result, setResult] = useState<RepositoryActionResult | null>(null);
  const [devServer, setDevServer] = useState(initialDevServer);
  const [springRuntime, setSpringRuntime] = useState(initialSpringRuntime);
  const [dependencies, setDependencies] = useState(initialDependencies);
  const [launchMode, setLaunchMode] = useState<NodeLaunchMode>(initialDevServer.launchMode ?? "dev");
  const [nodeRuntimes, setNodeRuntimes] = useState(initialNodeRuntimes);

  const run = (action: RepositoryAction) => {
    setActiveAction(action);
    setResult(null);
    if (action === "start-dependencies") {
      setDependencies((current) => current ? {
        ...current,
        canStart: false,
        services: current.services.map((dependency) => ({ ...dependency, state: "starting" })),
      } : current);
    }
    startTransition(async () => {
      try {
        const nextResult = await runRepositoryAction(repositoryId, action);
        setResult(nextResult);
        if (nextResult.devServer) {
          setDevServer(nextResult.devServer);
          if (nextResult.devServer.launchMode) setLaunchMode(nextResult.devServer.launchMode);
        }
        if (nextResult.springRuntime) setSpringRuntime(nextResult.springRuntime);
        if (nextResult.dependencies) setDependencies(nextResult.dependencies);
        if (nextResult.nodeRuntime) {
          const resultMode: NodeLaunchMode = action === "start-preview" ? "preview" : "dev";
          setNodeRuntimes((current) => current ? { ...current, [resultMode]: nextResult.nodeRuntime! } : current);
        }
      } catch {
        setResult({ status: "error", message: "The action could not be completed." });
        if (action === "start-dependencies") {
          setDependencies((current) => current ? {
            ...current,
            canStart: true,
            services: current.services.map((dependency) => ({ ...dependency, state: "failed" })),
          } : current);
        }
      } finally {
        setActiveAction(null);
      }
    });
  };

  const isSpringBoot = capabilities.hasSpringBoot;
  const isNextJs = technologies.includes("Next.js");
  const canStartDev = isSpringBoot || (capabilities.packageScripts.includes("dev") && Boolean(capabilities.packageManager));
  const canStartPreview = isNextJs && capabilities.packageScripts.includes("build") && capabilities.packageScripts.includes("start") && Boolean(capabilities.packageManager);
  const canStartSelectedMode = launchMode === "dev" ? canStartDev : canStartPreview;
  const canStopDev = devServer.ownedByDevHub && (devServer.state === "running" || devServer.state === "starting");
  const canTest = capabilities.packageScripts.includes("test") || capabilities.hasMavenWrapper;
  const hasChecks = canTest || capabilities.packageScripts.includes("lint") || capabilities.packageScripts.includes("build") || capabilities.hasMavenWrapper;
  const isJavaProject = isSpringBoot || capabilities.hasMavenWrapper
    || technologies.some((technology) => technology === "Java" || technology === "Maven" || technology === "Spring Boot");
  const effectiveActiveAction = isPending ? activeAction : null;
  const activeModeLabel = devServer.launchMode === "preview" ? "Preview" : "Dev";
  const runtimeLabel = devServer.state === "running"
    ? `Running${!isSpringBoot ? ` ${activeModeLabel}` : ""}${devServer.port ? ` · localhost:${devServer.port}` : ""}`
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
          {canStartDev || canStartPreview ? (
            <>
              {!isSpringBoot && isNextJs && nodeRuntimes && (
                <div className="launch-mode-panel">
                  <div className="launch-mode-heading"><span>Mode</span><strong>{launchMode === "dev" ? "Development" : "Preview"}</strong></div>
                  <div className="launch-mode-toggle" role="group" aria-label="Local launch mode">
                    <button type="button" className={launchMode === "dev" ? "active" : ""} aria-pressed={launchMode === "dev"} disabled={effectiveActiveAction !== null || canStopDev || !canStartDev} onClick={() => setLaunchMode("dev")}>Dev</button>
                    <button type="button" className={launchMode === "preview" ? "active" : ""} aria-pressed={launchMode === "preview"} disabled={effectiveActiveAction !== null || canStopDev || !canStartPreview} onClick={() => setLaunchMode("preview")}>Preview</button>
                  </div>
                  <p>{launchMode === "dev" ? "Hot reload · best while coding" : "Production build · closer to deployed behavior"}</p>
                  <dl className="node-runtime-summary">
                    <div><dt>Environment</dt><dd>{nodeRuntimes[launchMode].environment}</dd></div>
                    <div><dt>Profile</dt><dd>{nodeRuntimes[launchMode].profile}</dd></div>
                    <div><dt>Mode</dt><dd>{launchMode === "dev" ? "Dev" : "Preview"}</dd></div>
                  </dl>
                  {nodeRuntimes[launchMode].indicators.length > 0 && <p className="profile-indicators">{nodeRuntimes[launchMode].indicators.map((indicator) => `${indicator.name}: ${indicator.state}`).join(" · ")} · {nodeRuntimes[launchMode].source}</p>}
                  {nodeRuntimes[launchMode].demoMode && <p className="profile-warning"><AlertTriangle aria-hidden="true" size={13} /> Demo mode is explicitly selected by repository configuration.</p>}
                </div>
              )}
              {isSpringBoot && dependencies && dependencies.services.length > 0 && (
                <div className="dependency-panel">
                  <h4>Dependencies</h4>
                  <ul>
                    {dependencies.services.map((dependency) => (
                      <li key={dependency.service}>
                        <span><strong>{dependency.displayName}</strong><small>{dependency.service}{dependency.endpoint ? ` · ${dependency.endpoint}` : ""}</small></span>
                        <span className={`dependency-state dependency-${dependency.state}`}>{dependency.state === "ready" ? "Ready" : dependency.state === "starting" ? "Starting..." : dependency.state === "failed" ? "Failed" : dependency.state === "unknown" ? "Detected" : "Stopped"}</span>
                      </li>
                    ))}
                  </ul>
                  {(dependencies.canStart || dependencies.canStop) && (
                    <div className="action-buttons">
                      {dependencies.canStop
                        ? <ActionButton action="stop-dependencies" activeAction={effectiveActiveAction} onRun={run} icon={<Square aria-hidden="true" size={13} />} />
                        : <ActionButton action="start-dependencies" activeAction={effectiveActiveAction} onRun={run} icon={<Play aria-hidden="true" size={13} />} />}
                    </div>
                  )}
                  {dependencies.message && <p className="runtime-guidance">{dependencies.message}</p>}
                  {!dependencies.ownedByDevHub && dependencies.services.some((dependency) => dependency.state === "ready") && <p className="ownership-note">Reachable, but not started by this DevHub session; stop is unavailable.</p>}
                </div>
              )}
              {isSpringBoot && springRuntime && (
                <dl className="runtime-prerequisites">
                  {springRuntime.prerequisites.map((prerequisite) => (
                    <div key={`${prerequisite.kind}-${prerequisite.label}-${prerequisite.detail}`}>
                      <dt>{prerequisite.label}</dt>
                      <dd>
                        <span>{prerequisite.detail}</span>
                        <span className={`prerequisite-${prerequisite.state}`}>
                          {prerequisite.state === "ready" ? <Check aria-hidden="true" size={13} /> : prerequisite.state === "blocked" ? <X aria-hidden="true" size={13} /> : <AlertTriangle aria-hidden="true" size={13} />}
                          {prerequisite.state === "ready" ? "Ready" : prerequisite.state === "blocked" ? "Unavailable" : "Detected"}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="action-buttons">
                {canStopDev
                  ? <ActionButton action="stop-dev" activeAction={effectiveActiveAction} onRun={run} icon={<Square aria-hidden="true" size={13} />} label={isSpringBoot ? "Stop Backend" : devServer.launchMode === "preview" ? "Stop Preview" : undefined} />
                  : canStartSelectedMode && <ActionButton action={launchMode === "preview" ? "start-preview" : "start-dev"} activeAction={effectiveActiveAction} onRun={run} icon={<Play aria-hidden="true" size={13} />} label={isSpringBoot ? "Start Backend" : undefined} />}
                {devServer.url && <a className="project-action-button" href={devServer.url} target="_blank" rel="noreferrer">{isSpringBoot ? "Open Local API" : "Open Local App"} <ExternalLink aria-hidden="true" size={13} /></a>}
              </div>
              <p className="runtime-copy">{devServer.url ? `Local: ${devServer.url}` : devServer.message}</p>
              {isSpringBoot && springRuntime?.message && <p className="runtime-guidance">{springRuntime.message}</p>}
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
