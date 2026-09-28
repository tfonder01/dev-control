"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FolderPlus, LoaderCircle, Plus, X } from "lucide-react";

import { initialNewProjectState } from "./action-state";
import { createProjectAction } from "./actions";
import type { ProjectType } from "@/lib/projects/validation";

const PROJECT_TYPE_HELP: Record<ProjectType, string> = {
  existing: "Clone the repository exactly as it exists on GitHub.",
  nextjs: "For an empty GitHub repository: clone, then scaffold Next.js with TypeScript, App Router, Tailwind, ESLint, and pnpm.",
  "spring-boot": "Automatic scaffolding is intentionally deferred. Existing Spring repositories can still be cloned.",
  empty: "Clone an empty GitHub repository and add only the selected project files.",
};

export function NewProjectDialog({ categories }: { categories: string[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [projectType, setProjectType] = useState<ProjectType>("existing");
  const [state, formAction, pending] = useActionState(createProjectAction, initialNewProjectState);

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  function openDialog() {
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  return (
    <>
      <button className="new-project-button" type="button" onClick={openDialog}>
        <Plus aria-hidden="true" size={15} /> New Project
      </button>

      <dialog className="project-dialog" ref={dialogRef} onCancel={closeDialog}>
        <div className="dialog-heading">
          <div className="dialog-title">
            <span><FolderPlus aria-hidden="true" size={18} /></span>
            <div><p>New Project</p><h2>Initialize from GitHub URL</h2></div>
          </div>
          <button className="icon-button" type="button" aria-label="Close new project dialog" onClick={closeDialog}><X aria-hidden="true" size={17} /></button>
        </div>

        {state.status === "success" ? (
          <div className="project-success" role="status">
            <CheckCircle2 aria-hidden="true" size={28} />
            <h3>Project initialized</h3>
            <p>{state.message}</p>
            <button type="button" onClick={closeDialog}>Done</button>
          </div>
        ) : (
          <form action={formAction} className="project-form">
            <div className="form-field form-field-full">
              <label htmlFor="githubUrl">GitHub repository URL</label>
              <input id="githubUrl" name="githubUrl" type="url" required autoComplete="off" placeholder="https://github.com/owner/repository" aria-describedby={state.fieldErrors?.githubUrl ? "githubUrl-error" : undefined} />
              {state.fieldErrors?.githubUrl && <span className="field-error" id="githubUrl-error">{state.fieldErrors.githubUrl}</span>}
            </div>

            <div className="form-field">
              <label htmlFor="projectName">Local project name</label>
              <input id="projectName" name="projectName" required maxLength={80} autoComplete="off" placeholder="my-project" aria-describedby={state.fieldErrors?.projectName ? "projectName-error" : undefined} />
              {state.fieldErrors?.projectName && <span className="field-error" id="projectName-error">{state.fieldErrors.projectName}</span>}
            </div>

            <div className="form-field">
              <label htmlFor="category">Destination category</label>
              <input id="category" name="category" list="workspace-categories" autoComplete="off" placeholder="Internal Products" aria-describedby={state.fieldErrors?.category ? "category-error" : "category-help"} />
              <datalist id="workspace-categories">{categories.map((category) => <option value={category} key={category} />)}</datalist>
              <span className="field-help" id="category-help">Relative to DEV_CONTROL_ROOT. Leave blank for the root.</span>
              {state.fieldErrors?.category && <span className="field-error" id="category-error">{state.fieldErrors.category}</span>}
            </div>

            <div className="form-field">
              <label htmlFor="projectType">Project type</label>
              <select id="projectType" name="projectType" value={projectType} onChange={(event) => setProjectType(event.target.value as ProjectType)}>
                <option value="existing">Existing repo only</option>
                <option value="nextjs">Next.js</option>
                <option value="spring-boot">Spring Boot</option>
                <option value="empty">Empty</option>
              </select>
              {state.fieldErrors?.projectType && <span className="field-error">{state.fieldErrors.projectType}</span>}
            </div>

            <div className="form-field">
              <label htmlFor="packageManager">Package manager</label>
              <select id="packageManager" disabled><option>pnpm</option></select>
              <span className="field-help">Used for Node.js and Next.js projects.</span>
            </div>

            <p className="type-help form-field-full">{PROJECT_TYPE_HELP[projectType]}</p>

            <fieldset className="setup-options form-field-full">
              <legend>Optional setup</legend>
              <label><input type="checkbox" name="addReadme" /> <span>Add README</span></label>
              <label><input type="checkbox" name="addAgents" /> <span>Add AGENTS.md</span></label>
              <label><input type="checkbox" name="addClaude" /> <span>Add CLAUDE.md</span></label>
              <label><input type="checkbox" name="useEngineeringStandards" /> <span>Use engineering standards</span></label>
            </fieldset>

            {state.message && <div className="form-message" role="alert">{state.message}</div>}

            <div className="dialog-actions form-field-full">
              <button className="secondary-button" type="button" onClick={closeDialog} disabled={pending}>Cancel</button>
              <button className="primary-button" type="submit" disabled={pending || projectType === "spring-boot"}>
                {pending ? <><LoaderCircle className="spin" aria-hidden="true" size={15} /> Initializing…</> : "Initialize project"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
