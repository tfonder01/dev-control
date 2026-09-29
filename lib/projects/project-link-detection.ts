import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseEnvFile } from "./runtime-config.ts";
import { validateProjectUrl } from "./project-links-validation.ts";
import type { DetectedProjectLinks } from "./project-links-types.ts";
import type { Repository } from "../workspace/types.ts";

const MAX_CONFIG_BYTES = 256 * 1024;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function readSmallFile(repositoryPath: string, relativePath: string) {
  const filePath = path.join(repositoryPath, relativePath);
  try {
    const contents = await readFile(filePath, "utf8");
    return Buffer.byteLength(contents, "utf8") <= MAX_CONFIG_BYTES ? contents : null;
  } catch {
    return null;
  }
}

function addUnambiguousUrl(candidates: Map<"production" | "staging", Set<string>>, kind: "production" | "staging", value: string | undefined) {
  if (!value || /\$\{|<[^>]+>|example\.com/i.test(value)) return;
  const validated = validateProjectUrl(value);
  if (validated.ok && validated.url) candidates.get(kind)?.add(validated.url);
}

export async function detectProjectLinks(repository: Repository): Promise<DetectedProjectLinks> {
  const detected: DetectedProjectLinks = {};
  if (repository.git.githubUrl) detected.github = repository.git.githubUrl;

  const vercelContents = await readSmallFile(repository.path, path.join(".vercel", "project.json"));
  if (vercelContents) {
    try {
      const vercel = JSON.parse(vercelContents) as { projectName?: unknown; orgSlug?: unknown; teamSlug?: unknown };
      const projectName = typeof vercel.projectName === "string" ? vercel.projectName : "";
      const scope = typeof vercel.orgSlug === "string" ? vercel.orgSlug : typeof vercel.teamSlug === "string" ? vercel.teamSlug : "";
      if (SLUG_PATTERN.test(scope) && SLUG_PATTERN.test(projectName)) detected.vercel = `https://vercel.com/${scope}/${projectName}`;
    } catch {
      // Invalid local deployment metadata is ignored rather than guessed from.
    }
  }

  const candidates = new Map<"production" | "staging", Set<string>>([
    ["production", new Set()],
    ["staging", new Set()],
  ]);
  const envFiles = [".env", ".env.local", ".env.production", ".env.production.local", ".env.staging", ".env.staging.local"];
  const sentryPairs = new Set<string>();
  for (const fileName of envFiles) {
    const contents = await readSmallFile(repository.path, fileName);
    if (!contents) continue;
    const values = parseEnvFile(contents);
    [values.PRODUCTION_URL, values.PRODUCTION_APP_URL, values.NEXT_PUBLIC_PRODUCTION_URL].forEach((value) => addUnambiguousUrl(candidates, "production", value));
    [values.STAGING_URL, values.STAGING_APP_URL, values.NEXT_PUBLIC_STAGING_URL].forEach((value) => addUnambiguousUrl(candidates, "staging", value));
    if (fileName.startsWith(".env.production")) [values.NEXT_PUBLIC_APP_URL, values.NEXT_PUBLIC_SITE_URL, values.APP_URL, values.SITE_URL].forEach((value) => addUnambiguousUrl(candidates, "production", value));
    if (fileName.startsWith(".env.staging")) [values.NEXT_PUBLIC_APP_URL, values.NEXT_PUBLIC_SITE_URL, values.APP_URL, values.SITE_URL].forEach((value) => addUnambiguousUrl(candidates, "staging", value));
    if (SLUG_PATTERN.test(values.SENTRY_ORG ?? "") && SLUG_PATTERN.test(values.SENTRY_PROJECT ?? "")) {
      sentryPairs.add(`${values.SENTRY_ORG}\0${values.SENTRY_PROJECT}`);
    }
  }
  for (const kind of ["production", "staging"] as const) {
    const urls = [...(candidates.get(kind) ?? [])];
    if (urls.length === 1) detected[kind] = urls[0];
  }
  if (sentryPairs.size === 1) {
    const [sentryOrg, sentryProject] = [...sentryPairs][0].split("\0");
    detected.sentry = `https://sentry.io/organizations/${sentryOrg}/projects/${sentryProject}/`;
  }

  return detected;
}
