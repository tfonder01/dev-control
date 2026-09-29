"use client";

import { useRef, useState, useTransition } from "react";
import { ExternalLink, GitFork, Globe2, Link2, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";

import { saveProjectLinksAction } from "./actions";
import {
  PROJECT_ADD_LINK_DEFINITIONS,
  PROJECT_LINK_DEFINITIONS,
  type KnownProjectLinkKey,
  type ProjectLinksConfig,
  type ResolvedProjectLink,
} from "@/lib/projects/project-links-types";

type Props = {
  repositoryId: string;
  initialConfig: ProjectLinksConfig;
  initialLinks: ResolvedProjectLink[];
};

type EditorState = {
  kind: KnownProjectLinkKey | "custom";
  url: string;
  label: string;
  customIndex?: number;
  editing: boolean;
};

function LinkIcon({ kind }: { kind: ResolvedProjectLink["kind"] }) {
  if (kind === "github") return <GitFork aria-hidden="true" size={15} />;
  if (kind === "production" || kind === "staging") return <Globe2 aria-hidden="true" size={15} />;
  return <Link2 aria-hidden="true" size={15} />;
}

function toFormData(config: ProjectLinksConfig) {
  const formData = new FormData();
  PROJECT_LINK_DEFINITIONS.forEach((definition) => formData.set(`link-${definition.key}`, config.links[definition.key] ?? ""));
  config.customLinks.forEach((link) => {
    formData.append("custom-label", link.label);
    formData.append("custom-url", link.url);
  });
  return formData;
}

export function ProjectLinksPanel({ repositoryId, initialConfig, initialLinks }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [isPending, startTransition] = useTransition();
  const [config, setConfig] = useState(initialConfig);
  const [links, setLinks] = useState(initialLinks);
  const [editor, setEditor] = useState<EditorState>({ kind: "production", url: "", label: "", editing: false });
  const [message, setMessage] = useState<{ status: "success" | "error"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const openAdd = () => {
    setEditor({ kind: "production", url: "", label: "", editing: false });
    setFieldErrors({});
    setMessage(null);
    dialogRef.current?.showModal();
  };

  const openEdit = (link: ResolvedProjectLink) => {
    const customIndex = link.kind === "custom" ? Number(link.id.replace("custom-", "")) : undefined;
    setEditor({ kind: link.kind, url: link.url, label: link.kind === "custom" ? link.label : "", customIndex, editing: true });
    setFieldErrors({});
    setMessage(null);
    dialogRef.current?.showModal();
  };

  const closeDialog = () => {
    if (!isPending) dialogRef.current?.close();
  };

  const persist = (nextConfig: ProjectLinksConfig, closeOnSuccess = false) => {
    setFieldErrors({});
    setMessage(null);
    startTransition(async () => {
      const result = await saveProjectLinksAction(repositoryId, toFormData(nextConfig));
      if (result.status === "success" && result.config && result.links) {
        setConfig(result.config);
        setLinks(result.links);
        setMessage({ status: "success", text: result.message });
        if (closeOnSuccess) dialogRef.current?.close();
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        setMessage({ status: "error", text: result.message });
      }
    });
  };

  const submit = () => {
    const nextConfig: ProjectLinksConfig = { links: { ...config.links }, customLinks: config.customLinks.map((link) => ({ ...link })) };
    if (editor.kind === "custom") {
      const customLink = { label: editor.label, url: editor.url };
      if (editor.editing && editor.customIndex !== undefined) nextConfig.customLinks[editor.customIndex] = customLink;
      else nextConfig.customLinks.push(customLink);
    } else {
      nextConfig.links[editor.kind] = editor.url;
    }
    persist(nextConfig, true);
  };

  const remove = (link: ResolvedProjectLink) => {
    const nextConfig: ProjectLinksConfig = { links: { ...config.links }, customLinks: config.customLinks.map((item) => ({ ...item })) };
    if (link.kind === "custom") nextConfig.customLinks.splice(Number(link.id.replace("custom-", "")), 1);
    else delete nextConfig.links[link.kind];
    persist(nextConfig);
  };

  const selectedDefinition = PROJECT_LINK_DEFINITIONS.find((definition) => definition.key === editor.kind);
  const urlError = editor.kind === "custom" ? fieldErrors[`custom-${editor.customIndex ?? config.customLinks.length}-url`] : fieldErrors[`link-${editor.kind}`];
  const labelError = editor.kind === "custom" ? fieldErrors[`custom-${editor.customIndex ?? config.customLinks.length}-label`] : undefined;

  return (
    <section className="project-links-card" aria-labelledby="project-links-title">
      <div className="project-links-heading">
        <div className="card-heading project-links-title"><Link2 aria-hidden="true" size={16} /><h2 id="project-links-title">Project Links</h2></div>
        <button type="button" className="edit-links-button" onClick={openAdd}><Plus aria-hidden="true" size={13} /> Add link</button>
      </div>

      {links.length > 0 ? (
        <div className="project-links-grid">
          {links.map((link) => (
            <div className={`project-link-row ${link.kind === "production" || link.kind === "staging" ? "project-link-primary" : ""}`} key={link.id}>
              <span><LinkIcon kind={link.kind} /><strong>{link.label}</strong><small>{link.provenance === "detected" ? "Detected" : "Configured"}</small></span>
              <div className="project-link-actions">
                <a href={link.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${link.label} in a new tab`}>Open <ExternalLink aria-hidden="true" size={13} /></a>
                {link.provenance === "configured" && <button type="button" disabled={isPending} aria-label={`Edit ${link.label}`} onClick={() => openEdit(link)}><Pencil aria-hidden="true" size={13} /></button>}
                {link.provenance === "configured" && <button type="button" disabled={isPending} aria-label={`Remove ${link.label}`} onClick={() => remove(link)}><Trash2 aria-hidden="true" size={13} /></button>}
              </div>
            </div>
          ))}
        </div>
      ) : <div className="project-links-empty"><span>No project links configured or detected yet.</span></div>}
      {message && <p className={`project-links-status ${message.status === "error" ? "project-links-error" : ""}`} role={message.status === "error" ? "alert" : "status"}>{message.text}</p>}

      <dialog className="project-dialog link-editor-dialog" ref={dialogRef} onCancel={closeDialog}>
        <div className="dialog-heading">
          <div className="dialog-title"><span><Link2 aria-hidden="true" size={17} /></span><div><p>Project Links</p><h2>{editor.editing ? `Edit ${selectedDefinition?.label ?? editor.label}` : "Add link"}</h2></div></div>
          <button className="icon-button" type="button" aria-label="Close project link dialog" disabled={isPending} onClick={closeDialog}><X aria-hidden="true" size={17} /></button>
        </div>
        <form action={submit} className="project-form link-editor-form">
          <div className="form-field form-field-full">
            <label htmlFor="project-link-type">Type</label>
            <select id="project-link-type" value={editor.kind} disabled={editor.editing} onChange={(event) => setEditor((current) => ({ ...current, kind: event.target.value as EditorState["kind"], label: "" }))}>
              {editor.editing && editor.kind === "github" && <option value="github">GitHub</option>}
              {PROJECT_ADD_LINK_DEFINITIONS.map((definition) => <option value={definition.key} key={definition.key}>{definition.label}</option>)}
              <option value="custom">Custom</option>
            </select>
          </div>
          {editor.kind === "custom" && (
            <div className="form-field form-field-full">
              <label htmlFor="project-link-label">Custom label</label>
              <input id="project-link-label" type="text" maxLength={40} value={editor.label} placeholder="Admin Portal" onChange={(event) => setEditor((current) => ({ ...current, label: event.target.value }))} />
              {labelError && <span className="field-error">{labelError}</span>}
            </div>
          )}
          <div className="form-field form-field-full">
            <label htmlFor="project-link-url">URL</label>
            <input id="project-link-url" type="url" inputMode="url" autoComplete="off" required value={editor.url} placeholder="https://..." onChange={(event) => setEditor((current) => ({ ...current, url: event.target.value }))} />
            {urlError && <span className="field-error">{urlError}</span>}
          </div>
          {message?.status === "error" && <div className="form-message">{message.text}</div>}
          <div className="dialog-actions form-field-full">
            <button className="secondary-button" type="button" disabled={isPending} onClick={closeDialog}>Cancel</button>
            <button className="primary-button" type="submit" disabled={isPending}>{isPending && <LoaderCircle className="spin" aria-hidden="true" size={14} />}{isPending ? "Saving..." : editor.editing ? "Save changes" : "Add link"}</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
