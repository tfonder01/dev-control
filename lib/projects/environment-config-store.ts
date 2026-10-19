import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseWorkspaceEnvironmentConfig,
  parseWorkspaceEnvironmentConfigFile,
  type EnvironmentProfile,
  type WorkspaceEnvironmentConfig,
  type WorkspaceEnvironmentConfigFile,
} from "./environment-config";

export const ENVIRONMENT_CONFIG_PATH = path.join(process.cwd(), ".devhub", "environments.json");
export const BUILT_IN_ENVIRONMENT_CONFIG_PATH = path.join(process.cwd(), "config", "environment-profiles.json");
export const MANAGED_ENVIRONMENT_CONFIG_PATH = path.join(process.cwd(), ".devhub", "environment-profiles.local.json");

export type ManagedEnvironmentWorkspace = {
  id: string;
  profiles: EnvironmentProfile[];
  removedProfileIds: string[];
};

export type ManagedEnvironmentConfig = {
  version: 1;
  workspaces: ManagedEnvironmentWorkspace[];
};

export type EnvironmentProfileSource = "shipped" | "trusted-local" | "managed" | "customized";

export type EnvironmentProfileCatalog = WorkspaceEnvironmentConfigFile & {
  revision: string;
  managedRevision: string;
  sources: Record<string, EnvironmentProfileSource>;
  trustedProfiles: Record<string, EnvironmentProfile[]>;
};

const EMPTY_MANAGED_CONFIG: ManagedEnvironmentConfig = { version: 1, workspaces: [] };
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

function revisionFor(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 20);
}

function profileKey(workspaceId: string, profileId: string) {
  return `${workspaceId}:${profileId}`;
}

function parseManagedEnvironmentConfig(input: unknown): ManagedEnvironmentConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Managed environment configuration must be an object.");
  const root = input as Record<string, unknown>;
  if (Object.keys(root).some((key) => !["version", "workspaces"].includes(key)) || root.version !== 1 || !Array.isArray(root.workspaces)) {
    throw new Error("Managed environment configuration has an unsupported shape or version.");
  }
  const seenWorkspaces = new Set<string>();
  const workspaces = root.workspaces.map((candidate, workspaceIndex): ManagedEnvironmentWorkspace => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Managed workspace ${workspaceIndex} must be an object.`);
    const workspace = candidate as Record<string, unknown>;
    if (Object.keys(workspace).some((key) => !["id", "profiles", "removedProfileIds"].includes(key))
      || typeof workspace.id !== "string" || !ID_PATTERN.test(workspace.id)
      || !Array.isArray(workspace.profiles) || !Array.isArray(workspace.removedProfileIds)) {
      throw new Error(`Managed workspace ${workspaceIndex} has an unsupported shape.`);
    }
    if (seenWorkspaces.has(workspace.id)) throw new Error(`Managed environment configuration contains duplicate workspace ${workspace.id}.`);
    seenWorkspaces.add(workspace.id);
    const removedProfileIds = workspace.removedProfileIds.map((id) => {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`Managed workspace ${workspace.id} contains an invalid removed profile identifier.`);
      return id;
    });
    if (new Set(removedProfileIds).size !== removedProfileIds.length) throw new Error(`Managed workspace ${workspace.id} contains duplicate removed profile identifiers.`);
    return { id: workspace.id, profiles: workspace.profiles as EnvironmentProfile[], removedProfileIds };
  });
  return { version: 1, workspaces };
}

export async function loadManagedEnvironmentConfig(configPath = MANAGED_ENVIRONMENT_CONFIG_PATH) {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: EMPTY_MANAGED_CONFIG, revision: revisionFor(EMPTY_MANAGED_CONFIG) };
    throw new Error("Managed environment configuration could not be read.");
  }
  try {
    const config = parseManagedEnvironmentConfig(JSON.parse(contents));
    return { config, revision: revisionFor(config) };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Managed environment configuration is not valid JSON.");
    throw error;
  }
}

export async function saveManagedEnvironmentConfig(
  config: ManagedEnvironmentConfig,
  expectedRevision: string,
  configPath = MANAGED_ENVIRONMENT_CONFIG_PATH,
) {
  const current = await loadManagedEnvironmentConfig(configPath);
  if (current.revision !== expectedRevision) throw new Error("Environment profiles changed since this page was loaded. Refresh and review before saving again.");
  const parsed = parseManagedEnvironmentConfig(config);
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, configPath);
  return revisionFor(parsed);
}

export async function loadWorkspaceEnvironmentConfigs(configPath = ENVIRONMENT_CONFIG_PATH): Promise<WorkspaceEnvironmentConfigFile> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: [] };
    throw new Error("DevHub environment configuration could not be read.");
  }
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch {
    throw new Error("DevHub environment configuration is not valid JSON.");
  }
  const parsed = parseWorkspaceEnvironmentConfigFile(input);
  if (!parsed.ok) {
    const first = parsed.issues[0];
    throw new Error(`DevHub environment configuration is invalid at ${first.path}: ${first.message}`);
  }
  return parsed.config;
}

export async function loadEnvironmentProfileCatalog(
  builtInPath = BUILT_IN_ENVIRONMENT_CONFIG_PATH,
  ownerPath = ENVIRONMENT_CONFIG_PATH,
  managedPath = MANAGED_ENVIRONMENT_CONFIG_PATH,
): Promise<EnvironmentProfileCatalog> {
  const [builtIn, owner, managed] = await Promise.all([
    loadWorkspaceEnvironmentConfigs(builtInPath),
    loadWorkspaceEnvironmentConfigs(ownerPath),
    loadManagedEnvironmentConfig(managedPath),
  ]);
  const baseWorkspaces = [...builtIn.workspaces, ...owner.workspaces];
  const duplicate = baseWorkspaces.find((workspace, index) => baseWorkspaces.findIndex((candidate) => candidate.id === workspace.id) !== index);
  if (duplicate) throw new Error(`DevHub environment configuration contains duplicate workspace ${duplicate.id}.`);
  const sources: Record<string, EnvironmentProfileSource> = {};
  const trustedProfiles: Record<string, EnvironmentProfile[]> = {};
  builtIn.workspaces.forEach((workspace) => workspace.profiles.forEach((profile) => { sources[profileKey(workspace.id, profile.id)] = "shipped"; }));
  owner.workspaces.forEach((workspace) => workspace.profiles.forEach((profile) => { sources[profileKey(workspace.id, profile.id)] = "trusted-local"; }));
  const workspaces = baseWorkspaces.map((base): WorkspaceEnvironmentConfig => {
    const overlay = managed.config.workspaces.find((workspace) => workspace.id === base.id);
    trustedProfiles[base.id] = [...base.profiles, ...(overlay?.profiles ?? [])]
      .filter((profile, index, profiles) => profiles.findLastIndex((candidate) => candidate.id === profile.id) === index);
    if (!overlay) return base;
    const hidden = new Set(overlay.removedProfileIds);
    const overrides = new Map(overlay.profiles.map((profile) => [profile.id, profile]));
    const profiles = base.profiles.flatMap((profile) => {
      if (hidden.has(profile.id)) return [];
      const override = overrides.get(profile.id);
      if (!override) return [profile];
      overrides.delete(profile.id);
      sources[profileKey(base.id, profile.id)] = "customized";
      return [override];
    });
    for (const profile of overrides.values()) {
      if (!hidden.has(profile.id)) {
        profiles.push(profile);
        sources[profileKey(base.id, profile.id)] = "managed";
      }
    }
    const parsed = parseWorkspaceEnvironmentConfig({ ...base, profiles });
    if (!parsed.ok) {
      const first = parsed.issues[0];
      throw new Error(`Managed environment configuration is invalid for ${base.id} at ${first.path}: ${first.message}`);
    }
    return parsed.config;
  });
  const unknownWorkspace = managed.config.workspaces.find((workspace) => !baseWorkspaces.some((base) => base.id === workspace.id));
  if (unknownWorkspace) throw new Error(`Managed environment configuration references unknown workspace ${unknownWorkspace.id}.`);
  return {
    version: 1,
    workspaces,
    revision: revisionFor({ builtIn, owner, managed: managed.config }),
    managedRevision: managed.revision,
    sources,
    trustedProfiles,
  };
}
