export type Technology = {
  name: string;
  tone: "blue" | "cyan" | "green" | "orange" | "purple" | "slate";
};

export type GitMetadata = {
  branch: string;
  isDirty: boolean;
  changedFileCount: number;
  changedFiles: string[];
  hasConflicts: boolean;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  ahead: number | null;
  behind: number | null;
  latestCommitHash: string | null;
  latestCommitSubject: string | null;
  latestCommitTimestamp: string | null;
  originUrl: string | null;
  githubUrl: string | null;
  error: string | null;
};

export type ProjectCommand = {
  label: string;
  command: string;
};

export type PackageManager = "pnpm" | "npm" | "yarn";
export type ProjectScript = "dev" | "start" | "test" | "lint" | "build";
export type JavaBuildTool = "maven" | "gradle";

export type ProjectCapabilities = {
  packageManager: PackageManager | null;
  packageScripts: ProjectScript[];
  hasMavenWrapper: boolean;
  hasGradleWrapper: boolean;
  hasSpringBoot: boolean;
  javaBuildTool: JavaBuildTool | null;
  devPortHint: number | null;
  devPortSource: "script" | "spring-config" | "framework-default" | null;
};

export type ProjectService = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  kind: "node" | "spring-boot";
  technologies: Technology[];
  configurationFiles: string[];
  commands: ProjectCommand[];
  capabilities: ProjectCapabilities;
};

export type InfrastructureDefinition = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  kind: "docker-compose";
  configurationFile: string;
};

export type Repository = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  technologies: Technology[];
  configurationFiles: string[];
  services: ProjectService[];
  infrastructure: InfrastructureDefinition[];
  git: GitMetadata;
};

export type WorkspaceScanResult = {
  root: string | null;
  repositories: Repository[];
  warnings: string[];
  error: string | null;
  scannedAt: string;
};
