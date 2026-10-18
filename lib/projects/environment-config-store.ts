import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseWorkspaceEnvironmentConfigFile, type WorkspaceEnvironmentConfigFile } from "./environment-config";

export const ENVIRONMENT_CONFIG_PATH = path.join(process.cwd(), ".devhub", "environments.json");
export const BUILT_IN_ENVIRONMENT_CONFIG_PATH = path.join(process.cwd(), "config", "environment-profiles.json");

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
): Promise<WorkspaceEnvironmentConfigFile> {
  const [builtIn, owner] = await Promise.all([
    loadWorkspaceEnvironmentConfigs(builtInPath),
    loadWorkspaceEnvironmentConfigs(ownerPath),
  ]);
  const workspaces = [...builtIn.workspaces, ...owner.workspaces];
  const duplicate = workspaces.find((workspace, index) => workspaces.findIndex((candidate) => candidate.id === workspace.id) !== index);
  if (duplicate) throw new Error(`DevHub environment configuration contains duplicate workspace ${duplicate.id}.`);
  return { version: 1, workspaces };
}
