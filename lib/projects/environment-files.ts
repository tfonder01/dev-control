import "server-only";

import { readFile } from "node:fs/promises";

import type {
  EnvironmentFileReference,
  EnvironmentService,
  WorkspaceEnvironmentConfig,
} from "./environment-config";
import { parseEnvFile } from "./runtime-config";
import { resolveExternalEnvironmentFile, resolveRepositoryEnvironmentFile } from "./environment-file-resolution";
import type { Repository } from "@/lib/workspace/types";
import type { EnvironmentFileProvider } from "./environment-orchestrator";

type ResolvedEnvironmentFile = {
  id: string;
  path: string;
};

export type EnvironmentFileStatus = {
  id: string;
  source: "repository" | "external";
  available: boolean;
  message: string;
};

export type LoadedEnvironment = {
  environment: NodeJS.ProcessEnv;
  redactions: string[];
  sources: EnvironmentFileStatus[];
};

export async function resolveEnvironmentFiles(
  config: WorkspaceEnvironmentConfig,
  service: EnvironmentService,
  repositories: Repository[],
  ownerEnvironment: NodeJS.ProcessEnv = process.env,
) {
  const repositoryByReference = new Map(config.repositories.map((reference) => [
    reference.id,
    repositories.find((repository) => repository.id === reference.repositoryId) ?? null,
  ]));
  const externalByReference = new Map(config.externalEnvironmentFiles.map((reference) => [reference.id, reference]));
  const resolved: ResolvedEnvironmentFile[] = [];
  const sources: EnvironmentFileStatus[] = [];

  for (const [index, reference] of service.environmentFiles.entries()) {
    const id = `${service.id}:${index}`;
    try {
      let file: string;
      if (reference.source === "repository") {
        const repository = repositoryByReference.get(reference.repository);
        if (!repository) throw new Error("Repository unavailable.");
        file = await resolveRepositoryEnvironmentFile(repository.path, reference.path);
      } else {
        const external = externalByReference.get(reference.reference);
        if (!external) throw new Error("External reference unavailable.");
        file = await resolveExternalEnvironmentFile(external.pathVariable, external.relativePath, ownerEnvironment);
      }
      resolved.push({ id, path: file });
      sources.push({ id, source: reference.source, available: true, message: "Configured" });
    } catch {
      sources.push({ id, source: reference.source, available: false, message: reference.source === "external"
        ? `External environment reference ${reference.reference} is unavailable.`
        : `Repository environment reference ${reference.repository} is unavailable.` });
    }
  }
  return { files: resolved, sources };
}

export async function loadEnvironmentFiles(
  config: WorkspaceEnvironmentConfig,
  service: EnvironmentService,
  repositories: Repository[],
  ownerEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedEnvironment> {
  const resolved = await resolveEnvironmentFiles(config, service, repositories, ownerEnvironment);
  const environment = {} as NodeJS.ProcessEnv;
  const redactions = new Set<string>();
  for (const file of resolved.files) {
    let contents: string;
    try {
      contents = await readFile(file.path, "utf8");
    } catch {
      throw new Error(`Environment reference ${file.id} could not be loaded.`);
    }
    const parsed = parseEnvFile(contents);
    Object.assign(environment, parsed);
    for (const value of Object.values(parsed)) {
      if (value && value.length >= 4) redactions.add(value);
    }
  }
  return { environment, redactions: [...redactions], sources: resolved.sources };
}

export function environmentReferenceLabel(reference: EnvironmentFileReference) {
  return reference.source === "external" ? reference.reference : `${reference.repository}:${reference.path}`;
}

export function createEnvironmentFileProvider(
  config: WorkspaceEnvironmentConfig,
  repositories: Repository[],
  ownerEnvironment: NodeJS.ProcessEnv = process.env,
): EnvironmentFileProvider {
  return {
    inspect: async (service) => (await resolveEnvironmentFiles(config, service, repositories, ownerEnvironment)).sources,
    load: (service) => loadEnvironmentFiles(config, service, repositories, ownerEnvironment),
  };
}
