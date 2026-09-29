import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { EMPTY_PROJECT_LINKS, EMPTY_WORKSPACE_LINKS, WORKSPACE_LINK_DEFINITIONS, type ProjectLinksConfig, type WorkspaceLinksConfig } from "./project-links-types.ts";
import { isKnownProjectLinkKey, validateCustomLinkLabel, validateProjectUrl } from "./project-links-validation.ts";

type ProjectMetadataFile = {
  version: 1;
  workspaceLinks?: Partial<Record<string, string>>;
  workspaceCustomLinks?: Array<{ label: string; url: string }>;
  projects: Record<string, { links: Partial<Record<string, string>>; customLinks?: Array<{ label: string; url: string }> }>;
};

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

function normalizeConfig(value: unknown): ProjectLinksConfig {
  if (!value || typeof value !== "object") return { ...EMPTY_PROJECT_LINKS, links: {}, customLinks: [] };
  const raw = value as { links?: unknown; customLinks?: unknown };
  const links: ProjectLinksConfig["links"] = {};
  if (raw.links && typeof raw.links === "object") {
    for (const [key, candidate] of Object.entries(raw.links)) {
      if (!isKnownProjectLinkKey(key) || typeof candidate !== "string") continue;
      const validated = validateProjectUrl(candidate);
      if (validated.ok && validated.url) links[key] = validated.url;
    }
  }

  const customLinks: ProjectLinksConfig["customLinks"] = [];
  if (Array.isArray(raw.customLinks)) {
    for (const candidate of raw.customLinks.slice(0, 12)) {
      if (!candidate || typeof candidate !== "object") continue;
      const item = candidate as { label?: unknown; url?: unknown };
      if (typeof item.label !== "string" || typeof item.url !== "string") continue;
      const label = validateCustomLinkLabel(item.label);
      const url = validateProjectUrl(item.url);
      if (label.ok && url.ok && url.url) customLinks.push({ label: label.label, url: url.url });
    }
  }
  return { links, customLinks };
}

function normalizeWorkspaceConfig(value: unknown): WorkspaceLinksConfig {
  if (!value || typeof value !== "object") return { ...EMPTY_WORKSPACE_LINKS, links: {}, customLinks: [] };
  const raw = value as { links?: unknown; customLinks?: unknown };
  const allowed = new Set<string>(WORKSPACE_LINK_DEFINITIONS.map((definition) => definition.key));
  const links: WorkspaceLinksConfig["links"] = {};
  if (raw.links && typeof raw.links === "object") {
    for (const [key, candidate] of Object.entries(raw.links)) {
      if (!allowed.has(key) || typeof candidate !== "string") continue;
      const validated = validateProjectUrl(candidate);
      if (validated.ok && validated.url) links[key as keyof typeof links] = validated.url;
    }
  }
  const customLinks: WorkspaceLinksConfig["customLinks"] = [];
  if (Array.isArray(raw.customLinks)) {
    for (const candidate of raw.customLinks.slice(0, 12)) {
      if (!candidate || typeof candidate !== "object") continue;
      const item = candidate as { label?: unknown; url?: unknown };
      if (typeof item.label !== "string" || typeof item.url !== "string") continue;
      const label = validateCustomLinkLabel(item.label);
      const url = validateProjectUrl(item.url);
      if (label.ok && url.ok && url.url) customLinks.push({ label: label.label, url: url.url });
    }
  }
  return { links, customLinks };
}

export function createProjectLinksStore(metadataPath: string) {
  const metadataDirectory = path.dirname(metadataPath);
  let writeQueue: Promise<void> = Promise.resolve();

  async function readMetadata(): Promise<ProjectMetadataFile> {
    try {
      const raw = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1) {
        throw new Error("DevHub project metadata has an unsupported format.");
      }
      const projects = (raw as { projects?: unknown }).projects;
      if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
        throw new Error("DevHub project metadata is invalid.");
      }
      const metadata = raw as ProjectMetadataFile;
      return {
        version: 1,
        workspaceLinks: metadata.workspaceLinks,
        workspaceCustomLinks: metadata.workspaceCustomLinks,
        projects: projects as ProjectMetadataFile["projects"],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {} };
      throw error;
    }
  }

  async function writeMetadata(metadata: ProjectMetadataFile) {
    await mkdir(metadataDirectory, { recursive: true });
    const temporaryPath = path.join(metadataDirectory, `projects.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporaryPath, metadataPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    async getWorkspace() {
      const metadata = await readMetadata();
      return normalizeWorkspaceConfig({ links: metadata.workspaceLinks, customLinks: metadata.workspaceCustomLinks });
    },
    async saveWorkspace(config: WorkspaceLinksConfig) {
      const normalized = normalizeWorkspaceConfig(config);
      const operation = writeQueue.then(async () => {
        const metadata = await readMetadata();
        metadata.workspaceLinks = normalized.links;
        metadata.workspaceCustomLinks = normalized.customLinks;
        await writeMetadata(metadata);
        return normalized;
      });
      writeQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async get(repositoryId: string) {
      if (!PROJECT_ID_PATTERN.test(repositoryId)) return { links: {}, customLinks: [] } satisfies ProjectLinksConfig;
      const metadata = await readMetadata();
      return normalizeConfig(metadata.projects[repositoryId]);
    },
    async save(repositoryId: string, config: ProjectLinksConfig) {
      if (!PROJECT_ID_PATTERN.test(repositoryId)) throw new Error("Invalid repository identity.");
      const normalized = normalizeConfig(config);
      const operation = writeQueue.then(async () => {
        const metadata = await readMetadata();
        metadata.projects[repositoryId] = normalized;
        await writeMetadata(metadata);
        return normalized;
      });
      writeQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
