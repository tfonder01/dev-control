import {
  EMPTY_PROJECT_LINKS,
  PROJECT_LINK_DEFINITIONS,
  WORKSPACE_LINK_DEFINITIONS,
  type KnownProjectLinkKey,
  type ProjectLinksConfig,
  type WorkspaceLinksConfig,
} from "./project-links-types.ts";

const MAX_CUSTOM_LINKS = 12;
const MAX_LABEL_LENGTH = 40;

function stringValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

export function validateProjectUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, url: "" };

  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password) {
      return { ok: false as const, error: "Use an http or https URL without embedded credentials." };
    }
    return { ok: true as const, url: parsed.toString() };
  } catch {
    return { ok: false as const, error: "Enter a valid http or https URL." };
  }
}

export function validateCustomLinkLabel(value: string) {
  const label = value.trim();
  if (!label) return { ok: false as const, error: "Enter a label." };
  if (label.length > MAX_LABEL_LENGTH) return { ok: false as const, error: `Use ${MAX_LABEL_LENGTH} characters or fewer.` };
  if (/[<>\u0000-\u001f\u007f]/.test(label)) return { ok: false as const, error: "Use plain text without HTML or control characters." };
  return { ok: true as const, label };
}

function parseLinksForm<T extends string>(formData: FormData, definitions: readonly { key: T; label: string }[]) {
  const links: Partial<Record<T, string>> = {};
  const customLinks: ProjectLinksConfig["customLinks"] = [];
  const fieldErrors: Record<string, string> = {};

  for (const definition of definitions) {
    const raw = stringValue(formData.get(`link-${definition.key}`));
    if (!raw) continue;
    const validated = validateProjectUrl(raw);
    if (!validated.ok) fieldErrors[`link-${definition.key}`] = validated.error;
    else links[definition.key] = validated.url;
  }

  const labels = formData.getAll("custom-label");
  const urls = formData.getAll("custom-url");
  const count = Math.max(labels.length, urls.length);
  if (count > MAX_CUSTOM_LINKS) fieldErrors.custom = `Add no more than ${MAX_CUSTOM_LINKS} custom links.`;

  for (let index = 0; index < Math.min(count, MAX_CUSTOM_LINKS); index += 1) {
    const rawLabel = stringValue(labels[index] ?? null);
    const rawUrl = stringValue(urls[index] ?? null);
    if (!rawLabel && !rawUrl) continue;
    const label = validateCustomLinkLabel(rawLabel);
    const url = validateProjectUrl(rawUrl);
    if (!label.ok) fieldErrors[`custom-${index}-label`] = label.error;
    if (!rawUrl) fieldErrors[`custom-${index}-url`] = "Enter a URL.";
    else if (!url.ok) fieldErrors[`custom-${index}-url`] = url.error;
    if (label.ok && url.ok && url.url) customLinks.push({ label: label.label, url: url.url });
  }

  return Object.keys(fieldErrors).length > 0
    ? { ok: false as const, fieldErrors }
    : { ok: true as const, config: { links, customLinks }, fieldErrors: {} };
}

export function parseProjectLinksForm(formData: FormData) {
  const parsed = parseLinksForm(formData, PROJECT_LINK_DEFINITIONS);
  return parsed.ok
    ? { ...parsed, config: parsed.config satisfies ProjectLinksConfig }
    : { ...parsed, config: EMPTY_PROJECT_LINKS };
}

export function parseWorkspaceLinksForm(formData: FormData) {
  const parsed = parseLinksForm(formData, WORKSPACE_LINK_DEFINITIONS);
  return parsed.ok
    ? { ...parsed, config: parsed.config satisfies WorkspaceLinksConfig }
    : { ...parsed, config: { links: {}, customLinks: [] } satisfies WorkspaceLinksConfig };
}

export function isKnownProjectLinkKey(value: string): value is KnownProjectLinkKey {
  return PROJECT_LINK_DEFINITIONS.some((definition) => definition.key === value);
}
