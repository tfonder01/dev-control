import "server-only";

import type { WorkspaceEnvironmentConfig } from "./environment-config";
import { createEnvironmentAdapterRegistry } from "./environment-adapters";
import { createEnvironmentFileProvider } from "./environment-files";
import { EnvironmentOrchestrator } from "./environment-orchestrator";
import { createTrustedProcessController } from "./trusted-process-adapter";
import type { Repository } from "@/lib/workspace/types";

export function createWorkspaceEnvironmentOrchestrator(
  config: WorkspaceEnvironmentConfig,
  repositories: Repository[],
) {
  return new EnvironmentOrchestrator(
    config,
    repositories,
    createEnvironmentAdapterRegistry(createTrustedProcessController()),
    createEnvironmentFileProvider(config, repositories),
  );
}
