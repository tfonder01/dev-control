"use client";

import { useState, useTransition } from "react";
import { Copy, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { manageEnvironmentProfileAction } from "./actions";
import type {
  EnvironmentManagementRequest,
  EnvironmentManagementResponse,
  EnvironmentManagementView,
  EnvironmentProfileEditorView,
  ManagedProfileDraft,
  ManagedServiceDraft,
} from "@/lib/projects/environment-management";

type Props = {
  repositoryId: string;
  workspaceId: string;
  management: EnvironmentManagementView;
  disabled: boolean;
};

type EditorMode = "add" | "edit" | "duplicate";

function cloneProfile(profile: EnvironmentProfileEditorView): ManagedProfileDraft {
  return structuredClone({ id: profile.id, name: profile.name, risk: profile.risk, openUrl: profile.openUrl, services: profile.services });
}

function blankProfile(): ManagedProfileDraft {
  return { id: "", name: "", risk: "local", openUrl: "", services: [] };
}

function serviceFromTemplate(template: EnvironmentManagementView["templates"][number], index: number): ManagedServiceDraft {
  const id = `service-${index + 1}`;
  return {
    templateId: template.id,
    id,
    name: template.name,
    dependsOn: [],
    host: "127.0.0.1",
    port: template.defaultPort,
    launchMode: template.supportsLaunchMode ? "preview" : null,
    healthCheck: {
      type: template.adapter === "docker-compose" ? "docker-health" : template.adapter === "process" ? "process" : "http",
      path: template.adapter === "spring-boot" ? "/actuator/health" : "/",
      expectedStatuses: [200],
      timeoutMs: 90_000,
    },
    externalEnvironmentFiles: [],
  };
}

export function EnvironmentManager({ repositoryId, workspaceId, management, disabled }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<EditorMode | null>(null);
  const [sourceProfileId, setSourceProfileId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ManagedProfileDraft>(blankProfile);
  const [reviewing, setReviewing] = useState(false);
  const [result, setResult] = useState<EnvironmentManagementResponse | null>(null);
  const [isPending, startTransition] = useTransition();

  const begin = (nextMode: EditorMode, profile?: EnvironmentProfileEditorView) => {
    setMode(nextMode);
    setSourceProfileId(profile?.id ?? null);
    if (nextMode === "add") setDraft(blankProfile());
    else if (profile) {
      const next = cloneProfile(profile);
      if (nextMode === "duplicate") {
        next.id = `${profile.id}-copy`.slice(0, 64);
        next.name = `${profile.name} Copy`;
      }
      setDraft(next);
    }
    setReviewing(false);
    setResult(null);
  };

  const closeEditor = () => {
    setMode(null);
    setSourceProfileId(null);
    setReviewing(false);
  };

  const submit = (operation: EnvironmentManagementRequest["operation"], profile: ManagedProfileDraft | null, confirmedRemove: boolean, sourceId = sourceProfileId) => {
    setResult(null);
    startTransition(async () => {
      const response = await manageEnvironmentProfileAction({
        repositoryId,
        workspaceId,
        operation,
        expectedRevision: management.revision,
        sourceProfileId: sourceId,
        confirmedRemove,
        profile,
      });
      setResult(response);
      if (response.status === "success") {
        closeEditor();
        router.refresh();
      } else setReviewing(false);
    });
  };

  const remove = (profile: EnvironmentProfileEditorView) => {
    if (!window.confirm(`Remove ${profile.name} from DevHub? This does not delete containers, volumes, credentials, or project files.`)) return;
    submit("remove", null, true, profile.id);
  };

  const updateService = (index: number, change: Partial<ManagedServiceDraft>) => setDraft((current) => ({
    ...current,
    services: current.services.map((service, serviceIndex) => serviceIndex === index ? { ...service, ...change } : service),
  }));

  return (
    <div className="environment-manager">
      <button type="button" className="project-action-button environment-manage-button" disabled={disabled || isPending} onClick={() => setOpen((value) => !value)}>
        <Settings2 aria-hidden="true" size={14} /> Manage environments
      </button>

      {open && <div className="environment-manager-shell">
        <div className="environment-manager-heading">
          <div><strong>Manage environments</strong><p>Changes are saved to ignored local DevHub configuration. Shipped profiles remain untouched.</p></div>
          <button type="button" className="icon-button" aria-label="Close environment manager" onClick={() => { setOpen(false); closeEditor(); }}><X size={15} /></button>
        </div>

        {!mode && <>
          <div className="environment-manager-list">
            {management.profiles.map((profile) => <article key={profile.id}>
              <div><strong>{profile.name}</strong><span>{profile.id} · {profile.source === "shipped" ? "Shipped default" : profile.source === "customized" ? "Local override" : "Local profile"}</span></div>
              <div>
                <button type="button" disabled={isPending} onClick={() => begin("edit", profile)}><Pencil size={13} /> Edit</button>
                <button type="button" disabled={isPending} onClick={() => begin("duplicate", profile)}><Copy size={13} /> Duplicate</button>
                <button type="button" className="danger-button" disabled={isPending} onClick={() => remove(profile)}><Trash2 size={13} /> Remove</button>
              </div>
            </article>)}
          </div>
          <button type="button" className="project-action-button" disabled={isPending || management.templates.length === 0} onClick={() => begin("add")}><Plus size={14} /> Add environment</button>
          {management.templates.length === 0 && <p className="runtime-guidance">Add a trusted runtime definition in server-side configuration before creating an environment.</p>}
        </>}

        {mode && !reviewing && <div className="environment-editor">
          <div className="environment-editor-grid">
            <label>Name<input value={draft.name} maxLength={160} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>Identifier<input value={draft.id} maxLength={64} pattern="[a-z][a-z0-9-]{1,63}" onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></label>
            <label>Risk level<select value={draft.risk} onChange={(event) => setDraft({ ...draft, risk: event.target.value as ManagedProfileDraft["risk"] })}><option value="local">Development / test data</option><option value="real-data">Real data</option></select></label>
            <label>Open App URL<input type="url" placeholder="http://127.0.0.1:3000" value={draft.openUrl} onChange={(event) => setDraft({ ...draft, openUrl: event.target.value })} /></label>
          </div>

          <div className="environment-editor-services">
            <div className="environment-editor-section-heading"><strong>Services and dependency order</strong><button type="button" disabled={management.templates.length === 0} onClick={() => setDraft((current) => ({ ...current, services: [...current.services, serviceFromTemplate(management.templates[0], current.services.length)] }))}><Plus size={13} /> Add service</button></div>
            {draft.services.map((service, index) => {
              const template = management.templates.find((candidate) => candidate.id === service.templateId);
              return <fieldset key={`${service.id}-${index}`}>
                <legend>Service {index + 1}</legend>
                <div className="environment-editor-grid">
                  <label>Trusted adapter<select value={service.templateId} onChange={(event) => {
                    const nextTemplate = management.templates.find((candidate) => candidate.id === event.target.value);
                    if (nextTemplate) updateService(index, { ...serviceFromTemplate(nextTemplate, index), id: service.id, dependsOn: service.dependsOn });
                  }}>{management.templates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.runtimeType}</option>)}</select></label>
                  <label>Service name<input value={service.name} onChange={(event) => updateService(index, { name: event.target.value })} /></label>
                  <label>Service identifier<input value={service.id} onChange={(event) => updateService(index, { id: event.target.value })} /></label>
                  <label>Fixed port<input type="number" min={1} max={65535} value={service.port} onChange={(event) => updateService(index, { port: Number(event.target.value) })} /></label>
                  <label>Loopback host<select value={service.host} onChange={(event) => updateService(index, { host: event.target.value })}><option value="127.0.0.1">127.0.0.1</option><option value="localhost">localhost</option><option value="::1">::1</option></select></label>
                  <label>Depends on<select multiple value={service.dependsOn} onChange={(event) => updateService(index, { dependsOn: [...event.target.selectedOptions].map((option) => option.value) })}>{draft.services.filter((_, candidateIndex) => candidateIndex !== index).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.id}</option>)}</select></label>
                  <label>Health check<select value={service.healthCheck.type} onChange={(event) => updateService(index, { healthCheck: { ...service.healthCheck, type: event.target.value as ManagedServiceDraft["healthCheck"]["type"] } })}><option value="http">HTTP</option><option value="tcp">TCP</option>{template?.adapter === "docker-compose" && <option value="docker-health">Docker health</option>}{template?.adapter !== "docker-compose" && <option value="process">Process</option>}</select></label>
                  {service.healthCheck.type === "http" && <label>Health path<input value={service.healthCheck.path} onChange={(event) => updateService(index, { healthCheck: { ...service.healthCheck, path: event.target.value } })} /></label>}
                  {service.healthCheck.type === "http" && <label>Healthy HTTP statuses<input value={service.healthCheck.expectedStatuses.join(", ")} onChange={(event) => updateService(index, { healthCheck: { ...service.healthCheck, expectedStatuses: event.target.value.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value)) } })} /></label>}
                  <label>Health timeout (ms)<input type="number" min={250} max={300000} value={service.healthCheck.timeoutMs} onChange={(event) => updateService(index, { healthCheck: { ...service.healthCheck, timeoutMs: Number(event.target.value) } })} /></label>
                  {template?.supportsLaunchMode && <label>Frontend mode<select value={service.launchMode ?? "preview"} onChange={(event) => updateService(index, { launchMode: event.target.value as "dev" | "preview" })}><option value="preview">Preview</option><option value="dev">Development</option></select></label>}
                </div>
                {management.externalEnvironmentFiles.length > 0 && <div className="environment-reference-list"><span>Approved external environment references</span>{management.externalEnvironmentFiles.map((reference) => <label key={reference.id}><input type="checkbox" checked={service.externalEnvironmentFiles.includes(reference.id)} onChange={(event) => updateService(index, { externalEnvironmentFiles: event.target.checked ? [...service.externalEnvironmentFiles, reference.id] : service.externalEnvironmentFiles.filter((id) => id !== reference.id) })} />{reference.label}</label>)}</div>}
                <button type="button" className="danger-button" onClick={() => setDraft((current) => ({ ...current, services: current.services.filter((_, serviceIndex) => serviceIndex !== index) }))}><Trash2 size={13} /> Remove service</button>
              </fieldset>;
            })}
          </div>
          <div className="environment-editor-actions"><button type="button" onClick={closeEditor}>Cancel</button><button type="button" className="project-action-button" onClick={() => setReviewing(true)}>Review environment</button></div>
        </div>}

        {mode && reviewing && <div className="environment-review">
          <h3>Review before saving</h3>
          <dl><div><dt>Environment</dt><dd>{draft.name || "Unnamed"} ({draft.id || "no identifier"})</dd></div><div><dt>Risk</dt><dd>{draft.risk === "real-data" ? "Real data" : "Development / test data"}</dd></div><div><dt>Open App</dt><dd>{draft.openUrl || "Not configured"}</dd></div><div><dt>Services</dt><dd>{draft.services.length}</dd></div></dl>
          <ol>{draft.services.map((service) => <li key={service.id}>{service.name || service.id} · {service.host}:{service.port} · after {service.dependsOn.join(", ") || "none"}</li>)}</ol>
          <p>Saving changes configuration only. It does not start, stop, recreate, or delete runtime resources.</p>
          <div className="environment-editor-actions"><button type="button" onClick={() => setReviewing(false)}>Back</button><button type="button" className="project-action-button" disabled={isPending} onClick={() => submit(mode, draft, false)}>{isPending ? "Saving..." : "Save environment"}</button></div>
        </div>}

        {result && <div className={`action-result action-result-${result.status}`} role="status" aria-live="polite"><strong>{result.message}</strong>{result.fieldErrors && <ul>{Object.entries(result.fieldErrors).map(([field, message]) => <li key={field}><code>{field}</code>: {message}</li>)}</ul>}</div>}
      </div>}
    </div>
  );
}
