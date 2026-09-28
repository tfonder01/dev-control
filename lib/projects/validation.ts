import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export type ProjectType = "existing" | "nextjs" | "spring-boot" | "empty";

export type DestinationResult =
  | { ok: true; destination: string; categoryPath: string }
  | { ok: false; error: string };

export type GithubUrlResult =
  | { ok: true; cloneUrl: string; repositoryName: string }
  | { ok: false; error: string };

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CATEGORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

function isReservedWindowsName(value: string) {
  return WINDOWS_RESERVED_NAME.test(value);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isOutsideRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function validateGithubUrl(value: string): GithubUrlResult {
  const rawValue = value.trim();

  try {
    const url = new URL(rawValue);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return { ok: false, error: "Use a standard HTTPS GitHub repository URL." };
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
      return { ok: false, error: "Enter a repository URL like https://github.com/owner/repository." };
    }

    const [owner, rawRepository] = segments;
    const repository = rawRepository.replace(/\.git$/i, "");
    const validPart = /^[A-Za-z0-9_.-]+$/;
    if (!validPart.test(owner) || !validPart.test(repository) || repository === "." || repository === "..") {
      return { ok: false, error: "The GitHub owner or repository name is invalid." };
    }

    return {
      ok: true,
      cloneUrl: `https://github.com/${owner}/${repository}.git`,
      repositoryName: repository,
    };
  } catch {
    return { ok: false, error: "Enter a valid GitHub repository URL." };
  }
}

export async function resolveSafeDestination(
  workspaceRoot: string,
  category: string,
  projectName: string,
): Promise<DestinationResult> {
  const trimmedName = projectName.trim();
  if (!PROJECT_NAME.test(trimmedName) || isReservedWindowsName(trimmedName)) {
    return { ok: false, error: "Use 1–80 letters, numbers, dots, dashes, or underscores for the project name." };
  }

  const trimmedCategory = category.trim();
  if (trimmedCategory.length > 240 || path.isAbsolute(trimmedCategory) || /^[A-Za-z]:/.test(trimmedCategory)) {
    return { ok: false, error: "The destination category must be relative to DEV_CONTROL_ROOT." };
  }

  const segments = trimmedCategory ? trimmedCategory.split(/[\\/]/) : [];
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !CATEGORY_SEGMENT.test(segment) || segment.endsWith(".") || segment.endsWith(" ") || isReservedWindowsName(segment))) {
    return { ok: false, error: "The destination category contains an unsafe path segment." };
  }

  const root = path.resolve(workspaceRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return { ok: false, error: "DEV_CONTROL_ROOT could not be resolved." };
  }

  let inspectedCategory = root;
  for (const segment of segments) {
    inspectedCategory = path.join(inspectedCategory, segment);
    try {
      const stats = await lstat(inspectedCategory);
      if (stats.isSymbolicLink()) {
        return { ok: false, error: "Destination categories cannot pass through links or junctions." };
      }
      if (!stats.isDirectory()) {
        return { ok: false, error: "A destination category segment is not a directory." };
      }
      const canonicalCategory = await realpath(inspectedCategory);
      if (isOutsideRoot(canonicalRoot, canonicalCategory)) {
        return { ok: false, error: "The destination must remain inside DEV_CONTROL_ROOT." };
      }
    } catch (error) {
      if (isMissing(error)) break;
      return { ok: false, error: "The destination category could not be inspected safely." };
    }
  }

  const categoryPath = path.resolve(root, ...segments);
  const destination = path.resolve(categoryPath, trimmedName);
  const relativeDestination = path.relative(root, destination);

  if (!relativeDestination || isOutsideRoot(root, destination)) {
    return { ok: false, error: "The destination must remain inside DEV_CONTROL_ROOT." };
  }

  try {
    await lstat(destination);
    return { ok: false, error: "A file or folder already exists at that destination." };
  } catch (error) {
    if (!isMissing(error)) return { ok: false, error: "The destination could not be inspected safely." };
  }

  return { ok: true, destination, categoryPath };
}
