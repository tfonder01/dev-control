import type { ProjectType } from "@/lib/projects/validation";

export type NewProjectFormValues = {
  githubUrl: string;
  projectName: string;
  category: string;
  projectType: ProjectType;
  addReadme: boolean;
  addAgents: boolean;
  addClaude: boolean;
  useEngineeringStandards: boolean;
};

export type NewProjectState = {
  status: "idle" | "error" | "success";
  message: string;
  fieldErrors?: Partial<Record<"githubUrl" | "projectName" | "category" | "projectType", string>>;
  values?: NewProjectFormValues;
};

export const initialNewProjectState: NewProjectState = { status: "idle", message: "" };

export type RefreshWorkspaceState = {
  status: "idle" | "error" | "success";
  message: string;
};
