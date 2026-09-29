import {
  PROJECT_LINK_DEFINITIONS,
  WORKSPACE_LINK_DEFINITIONS,
  type DetectedProjectLinks,
  type ProjectLinksConfig,
  type ResolvedProjectLink,
  type WorkspaceLinksConfig,
} from "./project-links-types.ts";

export function resolveProjectLinks(config: ProjectLinksConfig, detected: DetectedProjectLinks): ResolvedProjectLink[] {
  const links: ResolvedProjectLink[] = [];
  const priority = ["production", "staging", "github"];
  const definitions = [...PROJECT_LINK_DEFINITIONS].sort((a, b) => {
    const aPriority = priority.indexOf(a.key);
    const bPriority = priority.indexOf(b.key);
    if (aPriority !== bPriority) return (aPriority < 0 ? 99 : aPriority) - (bPriority < 0 ? 99 : bPriority);
    return 0;
  });
  for (const definition of definitions) {
    const configuredUrl = config.links[definition.key];
    const url = configuredUrl ?? detected[definition.key];
    if (url) links.push({ id: definition.key, kind: definition.key, label: definition.label, url, provenance: configuredUrl ? "configured" : "detected" });
  }
  config.customLinks.forEach((link, index) => links.push({ id: `custom-${index}`, kind: "custom", ...link, provenance: "configured" }));
  return links;
}

export function resolveWorkspaceLinks(config: WorkspaceLinksConfig): ResolvedProjectLink[] {
  const links: ResolvedProjectLink[] = [];
  for (const definition of WORKSPACE_LINK_DEFINITIONS) {
    const url = config.links[definition.key];
    if (url) links.push({ id: definition.key, kind: definition.key, label: definition.label, url, provenance: "configured" });
  }
  config.customLinks.forEach((link, index) => links.push({ id: `custom-${index}`, kind: "custom", ...link, provenance: "configured" }));
  return links;
}
