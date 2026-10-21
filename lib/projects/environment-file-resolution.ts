import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ExternalEnvironmentFileFailure = "missing-variable" | "invalid-path";

export class ExternalEnvironmentFileResolutionError extends Error {
  readonly failure: ExternalEnvironmentFileFailure;

  constructor(failure: ExternalEnvironmentFileFailure) {
    super(failure === "missing-variable"
      ? "External environment path variable is not configured."
      : "External environment file path is missing or invalid.");
    this.name = "ExternalEnvironmentFileResolutionError";
    this.failure = failure;
  }
}

export function externalEnvironmentReferenceFailureMessage(referenceId: string, error: unknown) {
  if (!(error instanceof ExternalEnvironmentFileResolutionError)) {
    return `External environment reference ${referenceId} is unavailable.`;
  }
  return error.failure === "missing-variable"
    ? `External environment reference ${referenceId} is missing its configured path variable.`
    : `External environment reference ${referenceId} points to a missing or invalid file.`;
}

export type PersistentEnvironmentVariableReader = (name: string) => Promise<string | undefined>;

export async function readWindowsUserEnvironmentVariable(name: string): Promise<string | undefined> {
  if (process.platform !== "win32" || !ENVIRONMENT_NAME_PATTERN.test(name)) return undefined;
  const script = `$value = [Environment]::GetEnvironmentVariable('${name}', 'User'); if ($null -ne $value) { [Console]::Out.Write($value) }`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function inside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function existingFile(filePath: string) {
  const file = await realpath(filePath);
  const details = await stat(file);
  if (!details.isFile()) throw new Error("Not a file.");
  return file;
}

export async function resolveRepositoryEnvironmentFile(repositoryPath: string, relativePath: string) {
  const [root, file] = await Promise.all([
    realpath(repositoryPath),
    existingFile(path.resolve(repositoryPath, relativePath)),
  ]);
  if (!inside(root, file)) throw new Error("Repository environment reference is outside its trusted repository.");
  return file;
}

export async function resolveExternalEnvironmentFile(
  pathVariable: string,
  relativePath: string | null,
  environment: NodeJS.ProcessEnv,
  readPersistentEnvironmentVariable: PersistentEnvironmentVariableReader = readWindowsUserEnvironmentVariable,
) {
  const configured = environment[pathVariable]?.trim()
    || (await readPersistentEnvironmentVariable(pathVariable))?.trim();
  if (!configured) throw new ExternalEnvironmentFileResolutionError("missing-variable");
  if (!path.isAbsolute(configured)) throw new ExternalEnvironmentFileResolutionError("invalid-path");
  try {
    if (!relativePath) return await existingFile(configured);
    const root = await realpath(configured);
    const details = await stat(root);
    if (!details.isDirectory()) throw new ExternalEnvironmentFileResolutionError("invalid-path");
    const file = await existingFile(path.resolve(root, relativePath));
    if (!inside(root, file)) throw new ExternalEnvironmentFileResolutionError("invalid-path");
    return file;
  } catch (error) {
    if (error instanceof ExternalEnvironmentFileResolutionError) throw error;
    throw new ExternalEnvironmentFileResolutionError("invalid-path");
  }
}
