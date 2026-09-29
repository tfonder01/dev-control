"use client";

import { useRef, useState, useTransition } from "react";
import { ExternalLink, Link2, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";

import { saveWorkspaceLinksAction } from "./actions";
import {
  WORKSPACE_LINK_DEFINITIONS,
  type ResolvedProjectLink,
  type WorkspaceLinkKey,
  type WorkspaceLinksConfig,
} from "@/lib/projects/project-links-types";

type EditorState = {
  kind: WorkspaceLinkKey | "custom";
  url: string;
  label: string;
  customIndex?: number;
  editing: boolean;
};

function toFormData(config: WorkspaceLinksConfig) {
  const formData = new FormData();
  WORKSPACE_LINK_DEFINITIONS.forEach((definition) => formData.set(`link-${definition.key}`, config.links[definition.key] ?? ""));
  config.customLinks.forEach((link) => {
    formData.append("custom-label", link.label);
    formData.append("custom-url", link.url);
  });
  return formData;
}

export function WorkspaceLinksPanel({ initialConfig, initialLinks }: { initialConfig: WorkspaceLinksConfig; initialLinks: ResolvedProjectLink[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [isPending, startTransition] = useTransition();
  const [config, setConfig] = useState(initialConfig);
  const [links, setLinks] = useState(initialLinks);
  const [editor, setEditor] = useState<EditorState>({ kind: "github", url: "", label: "", editing: false });
  const [message, setMessage] = useState<{ status: "success" | "error"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const openAdd = () => {
    setEditor({ kind: "github", url: "", label: "", editing: false });
    setFieldErrors({});
    setMessage(null);
    dialogRef.current?.showModal();
  };
  const openEdit = (link: ResolvedProjectLink) => {
    const customIndex = link.kind === "custom" ? Number(link.id.replace("custom-", "")) : undefined;
    setEditor({ kind: link.kind as WorkspaceLinkKey | "custom", url: link.url, label: link.kind === "custom" ? link.label : "", customIndex, editing: true });
    setFieldErrors({});
    setMessage(null);
    dialogRef.current?.showModal();
  };
  const closeDialog = () => {
    if (!isPending) dialogRef.current?.close();
  };
  const persist = (nextConfig: WorkspaceLinksConfig, closeOnSuccess = false) => {
    setFieldErrors({});
    setMessage(null);
    startTransition(async () => {
      const result = await saveWorkspaceLinksAction(toFormData(nextConfig));
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
    const nextConfig: WorkspaceLinksConfig = { links: { ...config.links }, customLinks: config.customLinks.map((link) => ({ ...link })) };
    if (editor.kind === "custom") {
      const customLink = { label: editor.label, url: editor.url };
      if (editor.editing && editor.customIndex !== undefined) nextConfig.customLinks[editor.customIndex] = customLink;
      else nextConfig.customLinks.push(customLink);
    } else nextConfig.links[editor.kind] = editor.url;
    persist(nextConfig, true);
  };
  const remove = (link: ResolvedProjectLink) => {
    const nextConfig: WorkspaceLinksConfig = { links: { ...config.links }, customLinks: config.customLinks.map((item) => ({ ...item })) };
    if (link.kind === "custom") nextConfig.customLinks.splice(Number(link.id.replace("custom-", "")), 1);
    else delete nextConfig.links[link.kind as WorkspaceLinkKey];
    persist(nextConfig);
  };
  const urlError = editor.kind === "custom" ? fieldErrors[`custom-${editor.customIndex ?? config.customLinks.length}-url`] : fieldErrors[`link-${editor.kind}`];
  const labelError = editor.kind === "custom" ? fieldErrors[`custom-${editor.customIndex ?? config.customLinks.length}-label`] : undefined;

  return (
    <section className="workspace-links-card" aria-labelledby="workspace-links-title">
      <div className="workspace-links-heading">
        <div><p className="eyebrow">Shortcuts</p><h2 id="workspace-links-title">Workspace Links</h2></div>
        <button type="button" className="edit-links-button" onClick={openAdd}><Plus aria-hidden="true" size={13} /> Edit workspace links</button>
      </div>
      {links.length > 0 ? (
        <div className="workspace-link-list">
          {links.map((link) => (
            <div className="workspace-link-chip" key={link.id}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink aria-hidden="true" size={12} /></a>
              <button type="button" disabled={isPending} aria-label={`Edit ${link.label}`} onClick={() => openEdit(link)}><Pencil aria-hidden="true" size={12} /></button>
              <button type="button" disabled={isPending} aria-label={`Remove ${link.label}`} onClick={() => remove(link)}><Trash2 aria-hidden="true" size={12} /></button>
            </div>
          ))}
        </div>
      ) : <p className="workspace-links-empty">No workspace links configured yet.</p>}
      {message && <p className={`project-links-status ${message.status === "error" ? "project-links-error" : ""}`} role={message.status === "error" ? "alert" : "status"}>{message.text}</p>}

      <dialog className="project-dialog link-editor-dialog" ref={dialogRef} onCancel={closeDialog}>
        <div className="dialog-heading">
          <div className="dialog-title"><span><Link2 aria-hidden="true" size={17} /></span><div><p>Workspace Links</p><h2>{editor.editing ? "Edit link" : "Add link"}</h2></div></div>
          <button className="icon-button" type="button" aria-label="Close workspace link dialog" disabled={isPending} onClick={closeDialog}><X aria-hidden="true" size={17} /></button>
        </div>
        <form action={submit} className="project-form link-editor-form">
          <div className="form-field form-field-full">
            <label htmlFor="workspace-link-type">Type</label>
            <select id="workspace-link-type" value={editor.kind} disabled={editor.editing} onChange={(event) => setEditor((current) => ({ ...current, kind: event.target.value as EditorState["kind"], label: "" }))}>
              {WORKSPACE_LINK_DEFINITIONS.map((definition) => <option value={definition.key} key={definition.key}>{definition.label}</option>)}
              <option value="custom">Custom</option>
            </select>
          </div>
          {editor.kind === "custom" && <div className="form-field form-field-full"><label htmlFor="workspace-link-label">Custom label</label><input id="workspace-link-label" type="text" maxLength={40} required value={editor.label} placeholder="Team docs" onChange={(event) => setEditor((current) => ({ ...current, label: event.target.value }))} />{labelError && <span className="field-error">{labelError}</span>}</div>}
          <div className="form-field form-field-full"><label htmlFor="workspace-link-url">URL</label><input id="workspace-link-url" type="url" inputMode="url" autoComplete="off" required value={editor.url} placeholder="https://..." onChange={(event) => setEditor((current) => ({ ...current, url: event.target.value }))} />{urlError && <span className="field-error">{urlError}</span>}</div>
          {message?.status === "error" && <div className="form-message">{message.text}</div>}
          <div className="dialog-actions form-field-full"><button className="secondary-button" type="button" disabled={isPending} onClick={closeDialog}>Cancel</button><button className="primary-button" type="submit" disabled={isPending}>{isPending && <LoaderCircle className="spin" aria-hidden="true" size={14} />}{isPending ? "Saving..." : editor.editing ? "Save changes" : "Add link"}</button></div>
        </form>
      </dialog>
    </section>
  );
}
