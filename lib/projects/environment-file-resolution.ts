import { realpath, stat } from "node:fs/promises";
import path from "node:path";

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
) {
  const configured = environment[pathVariable]?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error("External environment reference is unavailable.");
  if (!relativePath) return existingFile(configured);
  const root = await realpath(configured);
  const details = await stat(root);
  if (!details.isDirectory()) throw new Error("External environment reference is unavailable.");
  const file = await existingFile(path.resolve(root, relativePath));
  if (!inside(root, file)) throw new Error("External environment reference escapes its owner-controlled base.");
  return file;
}
