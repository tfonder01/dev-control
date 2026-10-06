"use server";

import { revalidatePath } from "next/cache";

import type { NewProjectState, RefreshWorkspaceState } from "./action-state";
import type { RepositoryAction, RepositoryActionResult } from "@/lib/projects/action-types";
import { openInCursor, openInExplorer, openInIntelliJ, openTerminal, runProjectCheck } from "@/lib/projects/actions";
import { commitAndPush, type GitCommitPushRequest, type GitCommitPushResult } from "@/lib/projects/git-operations";
import { initializeProject, prepareDestinationCategory } from "@/lib/projects/operations";
import { detectProjectLinks } from "@/lib/projects/project-link-detection";
import { resolveProjectLinks, resolveWorkspaceLinks, saveProjectLinks, saveWorkspaceLinks } from "@/lib/projects/project-links";
import type { ProjectLinksActionResult, WorkspaceLinksActionResult } from "@/lib/projects/project-links-types";
import { parseProjectLinksForm, parseWorkspaceLinksForm } from "@/lib/projects/project-links-validation";
import { startDependencies, stopDependencies } from "@/lib/projects/dependencies";
import { startDevServer, startPreviewServer, stopDevServer } from "@/lib/projects/processes";
import { resolveSafeDestination, type ProjectType, validateGithubUrl } from "@/lib/projects/validation";
import { getRepositoryFromSnapshot, refreshWorkspaceSnapshot } from "@/lib/workspace/snapshot";

const REPOSITORY_ACTIONS = new Set<RepositoryAction>([
  "open-cursor", "open-intellij", "open-explorer", "open-terminal",
  "start-dev", "start-preview", "stop-dev",
  "start-dependencies", "stop-dependencies",
  "run-test", "run-lint", "run-build", "run-verify",
]);

export async function refreshWorkspaceAction(): Promise<RefreshWorkspaceState> {
  try {
    const snapshot = await refreshWorkspaceSnapshot();
    revalidatePath("/");
    return { status: "success", message: `Workspace refreshed in ${(snapshot.scanDurationMs / 1000).toFixed(1)}s` };
  } catch {
    return { status: "error", message: "Workspace refresh failed." };
  }
}

function value(formData: FormData, name: string) {
  const field = formData.get(name);
  return typeof field === "string" ? field : "";
}

function safeOperationError(error: unknown) {
  if (!(error instanceof Error)) return "Project initialization failed.";
  const firstLine = error.message.split("\n").find((line) => line.trim());
  return firstLine?.replace(/^Command failed:.*$/i, "The predefined project setup command failed.") ?? "Project initialization failed.";
}

export async function createProjectAction(
  _previousState: NewProjectState,
  formData: FormData,
): Promise<NewProjectState> {
  const githubUrl = value(formData, "githubUrl");
  const projectName = value(formData, "projectName");
  const category = value(formData, "category");
  const rawProjectType = value(formData, "projectType");
  const allowedProjectTypes: ProjectType[] = ["existing", "nextjs", "spring-boot", "empty"];
  const projectType = (allowedProjectTypes.includes(rawProjectType as ProjectType) ? rawProjectType : "existing") as ProjectType;
  const submittedValues = {
    githubUrl,
    projectName,
    category,
    projectType,
    addReadme: formData.get("addReadme") === "on",
    addAgents: formData.get("addAgents") === "on",
    addClaude: formData.get("addClaude") === "on",
    useEngineeringStandards: formData.get("useEngineeringStandards") === "on",
  };
  const workspaceRoot = process.env.DEV_CONTROL_ROOT?.trim();
  if (!workspaceRoot) return { status: "error", message: "DEV_CONTROL_ROOT is not configured.", values: submittedValues };
  const fieldErrors: NewProjectState["fieldErrors"] = {};

  const validatedUrl = validateGithubUrl(githubUrl);
  if (!validatedUrl.ok) fieldErrors.githubUrl = validatedUrl.error;
  if (!allowedProjectTypes.includes(rawProjectType as ProjectType)) fieldErrors.projectType = "Choose a supported project type.";

  const destination = await resolveSafeDestination(workspaceRoot, category, projectName);
  if (!destination.ok) {
    if (destination.error.includes("category") || destination.error.includes("DEV_CONTROL_ROOT")) fieldErrors.category = destination.error;
    else fieldErrors.projectName = destination.error;
  }

  if (Object.keys(fieldErrors).length > 0 || !validatedUrl.ok || !destination.ok) {
    return { status: "error", message: "Review the highlighted fields.", fieldErrors, values: submittedValues };
  }

  if (projectType === "spring-boot") {
    return {
      status: "error",
      message: "Automatic Spring Boot scaffolding is not enabled yet. Use “Existing repo only” to clone an existing Spring Boot repository.",
      fieldErrors: { projectType: "Spring Boot scaffolding requires an approved Initializr configuration." },
      values: submittedValues,
    };
  }

  try {
    await prepareDestinationCategory(destination.categoryPath, workspaceRoot);
    const result = await initializeProject({
      cloneUrl: validatedUrl.cloneUrl,
      destination: destination.destination,
      workspaceRoot,
      projectName: projectName.trim(),
      projectType,
      setup: {
        addReadme: submittedValues.addReadme,
        addAgents: submittedValues.addAgents,
        addClaude: submittedValues.addClaude,
        useEngineeringStandards: submittedValues.useEngineeringStandards,
      },
    });

    await refreshWorkspaceSnapshot();
    revalidatePath("/");
    const skipped = result.skippedFiles.length > 0
      ? ` Existing ${result.skippedFiles.join(", ")} preserved.`
      : "";
    return { status: "success", message: `${projectName.trim()} is ready.${skipped}` };
  } catch (error) {
    return { status: "error", message: safeOperationError(error), values: submittedValues };
  }
}

export async function runRepositoryAction(repositoryId: string, action: RepositoryAction): Promise<RepositoryActionResult> {
  if (!REPOSITORY_ACTIONS.has(action) || !/^[A-Za-z0-9_-]{16}$/.test(repositoryId)) {
    return { status: "error", message: "That repository action is not available." };
  }

  const repository = await getRepositoryFromSnapshot(repositoryId);
  if (!repository) return { status: "error", message: "The repository is no longer in the workspace snapshot. Refresh the dashboard and try again." };

  switch (action) {
    case "open-cursor": return openInCursor(repository);
    case "open-intellij": return openInIntelliJ(repository);
    case "open-explorer": return openInExplorer(repository);
    case "open-terminal": return openTerminal(repository);
    case "start-dev": return startDevServer(repository);
    case "start-preview": return startPreviewServer(repository);
    case "stop-dev": return stopDevServer(repository);
    case "start-dependencies": return startDependencies(repository);
    case "stop-dependencies": return stopDependencies(repository);
    case "run-test": return runProjectCheck(repository, "test");
    case "run-lint": return runProjectCheck(repository, "lint");
    case "run-build": return runProjectCheck(repository, "build");
    case "run-verify": return runProjectCheck(repository, "verify");
  }
}

export async function commitAndPushAction(repositoryId: string, request: GitCommitPushRequest): Promise<GitCommitPushResult> {
  if (!/^[A-Za-z0-9_-]{16}$/.test(repositoryId)) {
    return { status: "error", message: "That repository is not available." };
  }
  if (!request || typeof request.commitMessage !== "string"
    || typeof request.confirmProtectedBranch !== "boolean"
    || typeof request.confirmSetUpstream !== "boolean"
    || !Array.isArray(request.expectedChangedFiles)
    || request.expectedChangedFiles.length > 20_000
    || request.expectedChangedFiles.some((file) => typeof file !== "string")) {
    return { status: "error", message: "The Commit & Push request is invalid." };
  }

  const repository = await getRepositoryFromSnapshot(repositoryId);
  if (!repository) {
    return { status: "error", message: "The repository is no longer in the workspace snapshot. Refresh the dashboard and try again." };
  }

  const result = await commitAndPush(repository, request);
  if (result.status !== "confirmation-required") {
    await refreshWorkspaceSnapshot();
    revalidatePath("/");
    revalidatePath(`/projects/${repositoryId}`);
  }
  return result;
}

export async function refreshRepositoryGitAction(repositoryId: string) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(repositoryId)) return null;
  const snapshot = await refreshWorkspaceSnapshot();
  const repository = snapshot.repositories.find((candidate) => candidate.id === repositoryId);
  if (!repository) return null;
  revalidatePath("/");
  revalidatePath(`/projects/${repositoryId}`);
  return repository.git;
}

export async function saveProjectLinksAction(repositoryId: string, formData: FormData): Promise<ProjectLinksActionResult> {
  if (!/^[A-Za-z0-9_-]{16}$/.test(repositoryId)) {
    return { status: "error", message: "That project is not available." };
  }

  const repository = await getRepositoryFromSnapshot(repositoryId);
  if (!repository) {
    return { status: "error", message: "The repository is no longer in the workspace snapshot. Refresh the dashboard and try again." };
  }

  const parsed = parseProjectLinksForm(formData);
  if (!parsed.ok) {
    return { status: "error", message: "Review the highlighted links.", fieldErrors: parsed.fieldErrors };
  }

  try {
    const config = await saveProjectLinks(repositoryId, parsed.config);
    const detected = await detectProjectLinks(repository);
    revalidatePath(`/projects/${repositoryId}`);
    return {
      status: "success",
      message: "Project links saved.",
      config,
      links: resolveProjectLinks(config, detected),
    };
  } catch {
    return { status: "error", message: "Project links could not be saved. The existing metadata was preserved." };
  }
}

export async function saveWorkspaceLinksAction(formData: FormData): Promise<WorkspaceLinksActionResult> {
  const parsed = parseWorkspaceLinksForm(formData);
  if (!parsed.ok) {
    return { status: "error", message: "Review the highlighted links.", fieldErrors: parsed.fieldErrors };
  }

  try {
    const config = await saveWorkspaceLinks(parsed.config);
    revalidatePath("/");
    return { status: "success", message: "Workspace links saved.", config, links: resolveWorkspaceLinks(config) };
  } catch {
    return { status: "error", message: "Workspace links could not be saved. The existing metadata was preserved." };
  }
}
