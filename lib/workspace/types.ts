export type Technology = {
  name: string;
  tone: "blue" | "cyan" | "green" | "orange" | "purple" | "slate";
};

export type GitMetadata = {
  branch: string;
  isDirty: boolean;
  changedFileCount: number;
  changedFiles: string[];
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

export type Repository = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  technologies: Technology[];
  configurationFiles: string[];
  commands: ProjectCommand[];
  git: GitMetadata;
};

export type WorkspaceScanResult = {
  root: string | null;
  repositories: Repository[];
  warnings: string[];
  error: string | null;
  scannedAt: string;
};
