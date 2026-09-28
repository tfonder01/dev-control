"use server";

import { revalidatePath } from "next/cache";

import type { NewProjectState, RefreshWorkspaceState } from "./action-state";
import { initializeProject, prepareDestinationCategory } from "@/lib/projects/operations";
import { resolveSafeDestination, type ProjectType, validateGithubUrl } from "@/lib/projects/validation";
import { refreshWorkspaceSnapshot } from "@/lib/workspace/snapshot";

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
  const workspaceRoot = process.env.DEV_CONTROL_ROOT?.trim();
  if (!workspaceRoot) return { status: "error", message: "DEV_CONTROL_ROOT is not configured." };

  const githubUrl = value(formData, "githubUrl");
  const projectName = value(formData, "projectName");
  const category = value(formData, "category");
  const projectType = value(formData, "projectType") as ProjectType;
  const allowedProjectTypes: ProjectType[] = ["existing", "nextjs", "spring-boot", "empty"];
  const fieldErrors: NewProjectState["fieldErrors"] = {};

  const validatedUrl = validateGithubUrl(githubUrl);
  if (!validatedUrl.ok) fieldErrors.githubUrl = validatedUrl.error;
  if (!allowedProjectTypes.includes(projectType)) fieldErrors.projectType = "Choose a supported project type.";

  const destination = await resolveSafeDestination(workspaceRoot, category, projectName);
  if (!destination.ok) {
    if (destination.error.includes("category") || destination.error.includes("DEV_CONTROL_ROOT")) fieldErrors.category = destination.error;
    else fieldErrors.projectName = destination.error;
  }

  if (Object.keys(fieldErrors).length > 0 || !validatedUrl.ok || !destination.ok) {
    return { status: "error", message: "Review the highlighted fields.", fieldErrors };
  }

  if (projectType === "spring-boot") {
    return {
      status: "error",
      message: "Automatic Spring Boot scaffolding is not enabled yet. Use “Existing repo only” to clone an existing Spring Boot repository.",
      fieldErrors: { projectType: "Spring Boot scaffolding requires an approved Initializr configuration." },
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
        addReadme: formData.get("addReadme") === "on",
        addAgents: formData.get("addAgents") === "on",
        addClaude: formData.get("addClaude") === "on",
        useEngineeringStandards: formData.get("useEngineeringStandards") === "on",
      },
    });

    await refreshWorkspaceSnapshot();
    revalidatePath("/");
    const skipped = result.skippedFiles.length > 0
      ? ` Existing ${result.skippedFiles.join(", ")} preserved.`
      : "";
    return { status: "success", message: `${projectName.trim()} is ready.${skipped}` };
  } catch (error) {
    return { status: "error", message: safeOperationError(error) };
  }
}
