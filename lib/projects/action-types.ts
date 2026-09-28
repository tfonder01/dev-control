import type { ProjectCapabilities } from "@/lib/workspace/types";

export type RepositoryIde = "cursor" | "intellij";

export type RepositoryAction =
  | `open-${RepositoryIde}`
  | "open-explorer"
  | "open-terminal"
  | "start-dev"
  | "start-preview"
  | "stop-dev"
  | "start-dependencies"
  | "stop-dependencies"
  | "run-test"
  | "run-lint"
  | "run-build"
  | "run-verify";

export type DevServerStatus = {
  state: "stopped" | "starting" | "running" | "port-in-use" | "failed";
  ownedByDevHub: boolean;
  port: number | null;
  url: string | null;
  startedAt: string | null;
  message: string;
  output?: string;
  launchMode: NodeLaunchMode | null;
};

export type NodeLaunchMode = "dev" | "preview";

export type NodeRuntimeProfile = {
  environment: string;
  profile: string;
  source: string;
  indicators: { name: string; state: string }[];
  demoMode: boolean;
};

export type NodeRuntimeProfiles = Record<NodeLaunchMode, NodeRuntimeProfile>;

export type SpringRuntimePrerequisite = {
  kind: "environment" | "required-config" | "database" | "compose";
  label: string;
  detail: string;
  state: "ready" | "warning" | "blocked";
};

export type SpringRuntimeStatus = {
  environmentSource: string | null;
  prerequisites: SpringRuntimePrerequisite[];
  canStart: boolean;
  message: string | null;
};

export type DependencyServiceStatus = {
  displayName: string;
  service: string;
  endpoint: string | null;
  state: "stopped" | "starting" | "ready" | "failed" | "unknown";
};

export type DependencyRuntimeStatus = {
  composeFile: string | null;
  services: DependencyServiceStatus[];
  ownedByDevHub: boolean;
  canStart: boolean;
  canStop: boolean;
  message: string | null;
};

export type RepositoryActionResult = {
  status: "success" | "error" | "running" | "stopped";
  message: string;
  durationMs?: number;
  exitCode?: number | null;
  output?: string;
  devServer?: DevServerStatus;
  springRuntime?: SpringRuntimeStatus;
  dependencies?: DependencyRuntimeStatus;
  nodeRuntime?: NodeRuntimeProfile;
};

export type RepositoryActionsModel = {
  capabilities: ProjectCapabilities;
  devServer: DevServerStatus;
};
