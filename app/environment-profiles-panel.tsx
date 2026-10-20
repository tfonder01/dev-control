"use client";

import { useMemo, useState, useTransition } from "react";
import { ExternalLink, LoaderCircle, Play, RefreshCw, RotateCcw, ShieldAlert, Square, Workflow } from "lucide-react";

import { runEnvironmentProfileAction } from "./actions";
import { EnvironmentManager } from "./environment-manager";
import {
  environmentControlState,
  type EnvironmentActionResponse,
  type EnvironmentCatalogView,
  type EnvironmentLifecycleAction,
  type EnvironmentProfileView,
} from "@/lib/projects/environment-view";
import type { NodeLaunchMode } from "@/lib/projects/action-types";

type Props = { repositoryId: string; initialCatalog: EnvironmentCatalogView };

const stateLabels = { stopped: "Stopped", starting: "Starting", started: "Started", healthy: "Healthy", degraded: "Degraded" } as const;
const ownershipLabels = { none: "Not running", devhub: "DevHub-owned", external: "External", unverified: "Unverified" } as const;

function profileLaunchModes(profile: EnvironmentProfileView | null) {
  return Object.fromEntries(profile?.services
    .filter((service) => service.defaultLaunchMode)
    .map((service) => [service.id, service.runningLaunchMode ?? service.defaultLaunchMode!]) ?? []) as Record<string, NodeLaunchMode>;
}

export function EnvironmentProfilesPanel({ repositoryId, initialCatalog }: Props) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const workspaceId = initialCatalog.workspaces[0]?.id ?? "";
  const selectedWorkspace = catalog.workspaces.find((workspace) => workspace.id === workspaceId) ?? catalog.workspaces[0] ?? null;
  const [profileId, setProfileId] = useState(selectedWorkspace?.profiles[0]?.id ?? "");
  const selectedProfile = selectedWorkspace?.profiles.find((profile) => profile.id === profileId) ?? selectedWorkspace?.profiles[0] ?? null;
  const [confirmedRealData, setConfirmedRealData] = useState(false);
  const [activeAction, setActiveAction] = useState<EnvironmentLifecycleAction | null>(null);
  const [result, setResult] = useState<EnvironmentActionResponse | null>(null);
  const [launchModes, setLaunchModes] = useState<Record<string, NodeLaunchMode>>(() => profileLaunchModes(selectedProfile));
  const [isPending, startTransition] = useTransition();
  const controls = useMemo(() => selectedProfile ? environmentControlState(selectedProfile, isPending) : null, [selectedProfile, isPending]);

  if (!selectedWorkspace) {
    if (!initialCatalog.error) return null;
    return <section className="environment-panel"><p className="runtime-guidance">{initialCatalog.error}</p></section>;
  }

  const replaceProfile = (profile: EnvironmentProfileView) => {
    setCatalog((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => workspace.id !== selectedWorkspace.id ? workspace : {
        ...workspace,
        profiles: workspace.profiles.map((candidate) => candidate.id === profile.id ? profile : candidate),
      }),
    }));
  };

  const run = (action: EnvironmentLifecycleAction) => {
    if (!selectedProfile) return;
    setActiveAction(action);
    setResult(null);
    startTransition(async () => {
      try {
        const next = await runEnvironmentProfileAction({
          repositoryId,
          workspaceId: selectedWorkspace.id,
          profileId: selectedProfile.id,
          action,
          confirmedRealData,
          ...((action === "start" || action === "restart") ? { launchModes } : {}),
        });
        setResult(next);
        if (next.profile) replaceProfile(next.profile);
      } catch {
        setResult({ status: "error", message: "The environment action could not be completed safely.", profile: null });
      } finally {
        setActiveAction(null);
        if (selectedProfile.risk === "real-data") setConfirmedRealData(false);
      }
    });
  };

  const actionButton = (action: EnvironmentLifecycleAction, label: string, icon: React.ReactNode, enabled: boolean) => (
    <button type="button" className="project-action-button" disabled={!enabled} onClick={() => run(action)}>
      {isPending && activeAction === action ? <LoaderCircle className="spin" aria-hidden="true" size={14} /> : icon}
      {isPending && activeAction === action ? `${label}...` : label}
    </button>
  );
  const nodeServices = selectedProfile?.services.filter((service) => service.defaultLaunchMode) ?? [];
  const modeChangePending = nodeServices.some((service) => service.runningLaunchMode && launchModes[service.id] !== service.runningLaunchMode);

  return (
    <section className="environment-panel" aria-labelledby="environment-panel-title">
      <div className="project-actions-heading">
        <div><p className="eyebrow">Workspace</p><h2 id="environment-panel-title">Environment profiles</h2></div>
        {selectedProfile && <span className={`environment-state environment-${selectedProfile.state}`}><span aria-hidden="true" />{stateLabels[selectedProfile.state]}</span>}
      </div>

      <div className="environment-selectors">
        {selectedWorkspace.profiles.length > 1 ? <label>Environment<select value={selectedProfile?.id ?? ""} disabled={isPending} onChange={(event) => {
          const profile = selectedWorkspace.profiles.find((candidate) => candidate.id === event.target.value) ?? null;
          setProfileId(event.target.value);
          setLaunchModes(profileLaunchModes(profile));
          setConfirmedRealData(false);
          setResult(null);
        }}>{selectedWorkspace.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
          : <div className="environment-single-selection"><span>Environment</span><strong>{selectedProfile?.name ?? "No environments configured"}</strong></div>}
      </div>

      <EnvironmentManager repositoryId={repositoryId} workspaceId={selectedWorkspace.id} management={selectedWorkspace.management} disabled={isPending} />

      {!selectedProfile && <p className="runtime-guidance">Create an environment from an approved trusted service template to enable lifecycle controls.</p>}

      {selectedProfile && <>

      {nodeServices.map((service) => {
        const selectedMode = launchModes[service.id] ?? service.defaultLaunchMode!;
        const changingRunningMode = Boolean(service.runningLaunchMode && service.runningLaunchMode !== selectedMode);
        const modeLocked = isPending || service.ownership === "external" || service.ownership === "unverified";
        return (
          <div className="launch-mode-panel environment-launch-mode" key={`mode-${service.id}`}>
            <div className="launch-mode-heading"><span>{service.name} mode</span><strong>{selectedMode === "preview" ? "Preview" : "Development"}</strong></div>
            <div className="launch-mode-toggle" role="group" aria-label={`${service.name} environment launch mode`}>
              <button type="button" className={selectedMode === "dev" ? "active" : ""} aria-pressed={selectedMode === "dev"} disabled={modeLocked} onClick={() => setLaunchModes((current) => ({ ...current, [service.id]: "dev" }))}>Development</button>
              <button type="button" className={selectedMode === "preview" ? "active" : ""} aria-pressed={selectedMode === "preview"} disabled={modeLocked} onClick={() => setLaunchModes((current) => ({ ...current, [service.id]: "preview" }))}>Preview</button>
            </div>
            <p>{selectedMode === "dev" ? "Hot reload with next dev." : "Production-style next build followed by next start."}</p>
            <p>{service.runningLaunchMode
              ? `Running mode: ${service.runningLaunchMode === "preview" ? "Preview" : "Development"}.`
              : `Default mode: ${service.defaultLaunchMode === "preview" ? "Preview" : "Development"}.`}
              {changingRunningMode ? " Restart Environment to apply the selected mode." : ""}</p>
          </div>
        );
      })}

      {selectedProfile.risk === "real-data" && (
        <label className="real-data-confirmation">
          <input type="checkbox" checked={confirmedRealData} disabled={isPending} onChange={(event) => setConfirmedRealData(event.target.checked)} />
          <ShieldAlert aria-hidden="true" size={15} /> I understand this profile uses real data and want to run the selected lifecycle action.
        </label>
      )}

      <div className="environment-actions">
        {actionButton("start", "Start Environment", <Play aria-hidden="true" size={13} />, Boolean(controls?.canStart) && (selectedProfile.risk !== "real-data" || confirmedRealData))}
        {actionButton("stop", "Stop Environment", <Square aria-hidden="true" size={13} />, Boolean(controls?.canStop) && (selectedProfile.risk !== "real-data" || confirmedRealData))}
        {actionButton("restart", modeChangePending ? "Restart in Selected Mode" : "Restart Environment", <RotateCcw aria-hidden="true" size={13} />, Boolean(controls?.canRestart) && (selectedProfile.risk !== "real-data" || confirmedRealData))}
        {actionButton("inspect", "Refresh Status", <RefreshCw aria-hidden="true" size={13} />, !isPending)}
        {selectedProfile.openUrl && <a className={`project-action-button${controls?.canOpen ? "" : " action-link-disabled"}`} aria-disabled={!controls?.canOpen} href={controls?.canOpen ? selectedProfile.openUrl : undefined} target="_blank" rel="noreferrer">Open App <ExternalLink aria-hidden="true" size={13} /></a>}
      </div>

      <div className="environment-service-list">
        {selectedProfile.services.map((service) => (
          <article className="environment-service" key={service.id}>
            <div className="environment-service-heading">
              <span className="environment-service-icon"><Workflow aria-hidden="true" size={14} /></span>
              <div><h3>{service.name}</h3><p>{service.runtimeType}{service.runningLaunchMode ? ` · ${service.runningLaunchMode === "preview" ? "Preview" : "Development"}` : ""}{service.endpoint ? ` · ${service.endpoint}` : ""}</p></div>
              <span className={`environment-state environment-${service.state}`}><span aria-hidden="true" />{stateLabels[service.state]}</span>
            </div>
            <details className="environment-service-diagnostics">
              <summary>Service diagnostics</summary>
              <dl>
                <div><dt>Stage</dt><dd>{service.stage}</dd></div>
                <div><dt>Ownership</dt><dd>{ownershipLabels[service.ownership]}</dd></div>
                <div><dt>Endpoint</dt><dd>{service.endpoint ?? "Not configured"}</dd></div>
                <div><dt>Reason</dt><dd>{service.diagnostic}</dd></div>
                {service.historicalDiagnostic && <div><dt>Previous startup failure</dt><dd>{service.historicalDiagnostic}</dd></div>}
                {service.historicalFailureAt && <div><dt>Failure recorded</dt><dd><time dateTime={service.historicalFailureAt}>{new Date(service.historicalFailureAt).toISOString()}</time></dd></div>}
                {service.defaultLaunchMode && <div><dt>Mode</dt><dd>{service.runningLaunchMode ? `Running ${service.runningLaunchMode === "preview" ? "Preview" : "Development"}` : `Default ${service.defaultLaunchMode === "preview" ? "Preview" : "Development"}`}</dd></div>}
                {service.exitSummary && <div><dt>Exit</dt><dd>{service.exitSummary}</dd></div>}
              </dl>
              {service.recentLogs && <div className="environment-log-tail"><strong>Recent sanitized output (retained)</strong><pre>{service.recentLogs}</pre></div>}
              {service.historicalLogs && <div className="environment-log-tail"><strong>Previous startup output (sanitized)</strong><pre>{service.historicalLogs}</pre></div>}
            </details>
          </article>
        ))}
      </div>

      {selectedProfile.guidance.length > 0 && <div className="environment-guidance"><strong>Recovery guidance</strong><ul>{selectedProfile.guidance.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {result && <div className={`action-result action-result-${result.status}`} role="status" aria-live="polite"><div><strong>{result.message}</strong></div></div>}
      </>}
    </section>
  );
}
