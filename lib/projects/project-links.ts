import "server-only";

import path from "node:path";

import {
  type ProjectLinksConfig,
  type WorkspaceLinksConfig,
} from "./project-links-types";
import { createProjectLinksStore } from "./project-links-store";
export { resolveProjectLinks, resolveWorkspaceLinks } from "./project-links-resolution";

const METADATA_DIRECTORY = path.join(process.cwd(), ".devhub");
export const PROJECT_METADATA_PATH = path.join(METADATA_DIRECTORY, "projects.json");
const projectLinksStore = createProjectLinksStore(PROJECT_METADATA_PATH);

export async function getProjectLinks(repositoryId: string) {
  return projectLinksStore.get(repositoryId);
}

export async function saveProjectLinks(repositoryId: string, config: ProjectLinksConfig) {
  return projectLinksStore.save(repositoryId, config);
}

export async function getWorkspaceLinks() {
  return projectLinksStore.getWorkspace();
}

export async function saveWorkspaceLinks(config: WorkspaceLinksConfig) {
  return projectLinksStore.saveWorkspace(config);
}
