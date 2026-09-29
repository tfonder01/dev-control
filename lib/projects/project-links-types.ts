export const PROJECT_LINK_DEFINITIONS = [
  { key: "github", label: "GitHub" },
  { key: "production", label: "Production" },
  { key: "staging", label: "Staging" },
  { key: "vercel", label: "Vercel" },
  { key: "render", label: "Render" },
  { key: "sentry", label: "Sentry" },
  { key: "neon", label: "Neon" },
  { key: "stripe", label: "Stripe" },
  { key: "jotform", label: "Jotform" },
  { key: "base44", label: "Base44" },
  { key: "mailtrap", label: "Mailtrap" },
  { key: "docs", label: "Documentation" },
] as const;

export type KnownProjectLinkKey = typeof PROJECT_LINK_DEFINITIONS[number]["key"];
export const PROJECT_ADD_LINK_DEFINITIONS = PROJECT_LINK_DEFINITIONS.filter((definition) => definition.key !== "github");

export const WORKSPACE_LINK_DEFINITIONS = [
  { key: "github", label: "GitHub" },
  { key: "vercel", label: "Vercel" },
  { key: "render", label: "Render" },
  { key: "sentry", label: "Sentry" },
  { key: "neon", label: "Neon" },
  { key: "stripe", label: "Stripe" },
  { key: "jotform", label: "Jotform" },
  { key: "base44", label: "Base44" },
  { key: "mailtrap", label: "Mailtrap" },
  { key: "docs", label: "Documentation" },
] as const;

export type WorkspaceLinkKey = typeof WORKSPACE_LINK_DEFINITIONS[number]["key"];

export type CustomProjectLink = {
  label: string;
  url: string;
};

export type ProjectLinksConfig = {
  links: Partial<Record<KnownProjectLinkKey, string>>;
  customLinks: CustomProjectLink[];
};

export type WorkspaceLinksConfig = {
  links: Partial<Record<WorkspaceLinkKey, string>>;
  customLinks: CustomProjectLink[];
};

export type DetectedProjectLinks = Partial<Record<KnownProjectLinkKey, string>>;

export type ResolvedProjectLink = {
  id: string;
  kind: KnownProjectLinkKey | "custom";
  label: string;
  url: string;
  provenance: "detected" | "configured";
};

export type ProjectLinksActionResult = {
  status: "success" | "error";
  message: string;
  config?: ProjectLinksConfig;
  links?: ResolvedProjectLink[];
  fieldErrors?: Record<string, string>;
};

export type WorkspaceLinksActionResult = {
  status: "success" | "error";
  message: string;
  config?: WorkspaceLinksConfig;
  links?: ResolvedProjectLink[];
  fieldErrors?: Record<string, string>;
};

export const EMPTY_PROJECT_LINKS: ProjectLinksConfig = { links: {}, customLinks: [] };
export const EMPTY_WORKSPACE_LINKS: WorkspaceLinksConfig = { links: {}, customLinks: [] };
