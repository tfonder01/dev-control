export type NewProjectState = {
  status: "idle" | "error" | "success";
  message: string;
  fieldErrors?: Partial<Record<"githubUrl" | "projectName" | "category" | "projectType", string>>;
};

export const initialNewProjectState: NewProjectState = { status: "idle", message: "" };

export type RefreshWorkspaceState = {
  status: "idle" | "error" | "success";
  message: string;
};
