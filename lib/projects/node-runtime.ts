import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { NodeLaunchMode, NodeRuntimeProfile, NodeRuntimeProfiles } from "./action-types";
import { createBoundedRuntimeEnvironment } from "./runtime-environment";
import { isNodeProfileSelector, isSensitiveEnvironmentName, parseEnvFile, safeProfileState } from "./runtime-config";
import type { Repository } from "@/lib/workspace/types";

type ResolvedNodeRuntime = {
  status: NodeRuntimeProfile;
  environment: NodeJS.ProcessEnv;
  redactions: string[];
};

function envFiles(mode: NodeLaunchMode) {
  const nodeEnvironment = mode === "dev" ? "development" : "production";
  return [".env", `.env.${nodeEnvironment}`, ".env.local", `.env.${nodeEnvironment}.local`];
}

async function readOptional(filePath: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function resolveNodeRuntime(repository: Repository, mode: NodeLaunchMode): Promise<ResolvedNodeRuntime> {
  const resolved: Record<string, string> = {};
  const sources = new Map<string, string>();
  const redactions = new Set<string>();

  for (const file of envFiles(mode)) {
    const contents = await readOptional(path.join(/* turbopackIgnore: true */ repository.path, file));
    if (contents === null) continue;
    for (const [name, value] of Object.entries(parseEnvFile(contents))) {
      resolved[name] = value;
      sources.set(name, file);
      if (isSensitiveEnvironmentName(name) && value) redactions.add(value);
    }
  }

  const selectors = Object.entries(resolved)
    .filter(([name]) => isNodeProfileSelector(name))
    .map(([name, value]) => ({ name, state: safeProfileState(name, value), source: sources.get(name) ?? ".env" }));
  const primary = selectors.find((item) => item.state === "Demo")
    ?? selectors.find((item) => /APP_MODE$/i.test(item.name))
    ?? selectors.find((item) => /PROFILE$/i.test(item.name))
    ?? selectors[0];
  const source = primary?.source ?? "Default local launch";
  const hasLocalSource = selectors.some((item) => item.source.includes(".local"));
  const status: NodeRuntimeProfile = {
    environment: hasLocalSource || selectors.length === 0 ? "Local" : mode === "dev" ? "Development" : "Production",
    profile: primary?.state ?? "Local",
    source,
    indicators: selectors.map(({ name, state }) => ({ name, state })),
    demoMode: selectors.some((item) => item.state === "Demo"),
  };

  const environment = createBoundedRuntimeEnvironment(process.env, {
    NODE_ENV: mode === "dev" ? "development" : "production",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  for (const [name, value] of Object.entries(environment)) {
    if (value && isSensitiveEnvironmentName(name)) redactions.add(value);
  }

  return { status, environment: environment as NodeJS.ProcessEnv, redactions: [...redactions] };
}

export async function resolveNodeRuntimeProfiles(repository: Repository): Promise<NodeRuntimeProfiles> {
  const [dev, preview] = await Promise.all([
    resolveNodeRuntime(repository, "dev"),
    resolveNodeRuntime(repository, "preview"),
  ]);
  return { dev: dev.status, preview: preview.status };
}
