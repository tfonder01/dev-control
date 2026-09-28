import type { ProjectCapabilities } from "@/lib/workspace/types";

export type RepositoryIde = "cursor" | "intellij";

export type RepositoryAction =
  | `open-${RepositoryIde}`
  | "open-explorer"
  | "open-terminal"
  | "start-dev"
  | "stop-dev"
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
};

export type RepositoryActionResult = {
  status: "success" | "error" | "running" | "stopped";
  message: string;
  durationMs?: number;
  exitCode?: number | null;
  output?: string;
  devServer?: DevServerStatus;
};

export type RepositoryActionsModel = {
  capabilities: ProjectCapabilities;
  devServer: DevServerStatus;
};
