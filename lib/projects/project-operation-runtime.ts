import { stat } from "node:fs/promises";
import path from "node:path";

export type ProjectProgram = "git" | "pnpm";

export type ProgramInvocation = {
  executable: string;
  argsPrefix: string[];
};

export function resolveProgramInvocation(
  program: ProjectProgram,
  platform = process.platform,
  environment: Record<string, string | undefined> = process.env,
): ProgramInvocation {
  if (program === "git") return { executable: "git", argsPrefix: [] };
  if (platform !== "win32") return { executable: "pnpm", argsPrefix: [] };

  const configuredComSpec = environment.ComSpec?.trim();
  const systemRoot = environment.SystemRoot?.trim() || environment.WINDIR?.trim();
  const executable = configuredComSpec && path.win32.isAbsolute(configuredComSpec)
    ? configuredComSpec
    : systemRoot && path.win32.isAbsolute(systemRoot)
      ? path.win32.join(systemRoot, "System32", "cmd.exe")
      : "cmd.exe";

  return { executable, argsPrefix: ["/d", "/s", "/c", "pnpm.cmd"] };
}

export async function validateSpawnCwd(cwd: string) {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("The project command working directory is invalid.");
  try {
    const details = await stat(cwd);
    if (!details.isDirectory()) throw new Error("The project command working directory is not a directory.");
  } catch (error) {
    if (error instanceof Error && error.message === "The project command working directory is not a directory.") throw error;
    throw new Error("The project command working directory does not exist.");
  }
}

export type InitializationStage = "remote-check" | "reserve" | "clone" | "scaffold" | "optional-files";

export class ProjectInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectInitializationError";
  }
}

export type InitializationDependencies = {
  ensureRemoteIsEmpty: () => Promise<void>;
  reserveDestination: () => Promise<void>;
  cloneRepository: () => Promise<void>;
  scaffoldNextApp: () => Promise<void>;
  addOptionalFiles: () => Promise<string[]>;
  removeDestination: () => Promise<void>;
};

function stageFailureMessage(stage: InitializationStage, destinationOwned: boolean, cleaned: boolean) {
  const retry = cleaned
    ? " DevHub removed the incomplete local destination, so retrying is safe."
    : destinationOwned
      ? " DevHub could not remove the incomplete local destination; inspect it before retrying."
      : "";
  if (stage === "scaffold") return `Repository cloned, but Next.js scaffolding failed.${retry}`;
  if (stage === "optional-files") return `Project scaffolding completed, but optional project files could not be added.${retry}`;
  if (stage === "clone") return `Repository cloning failed.${retry}`;
  if (stage === "reserve") return "The destination could not be reserved. No existing files were changed.";
  return "The remote repository could not be validated.";
}

export async function runInitializationStages(
  projectType: "existing" | "nextjs" | "empty",
  dependencies: InitializationDependencies,
) {
  let destinationOwned = false;
  let stage: InitializationStage = "remote-check";

  try {
    if (projectType === "nextjs" || projectType === "empty") await dependencies.ensureRemoteIsEmpty();
    stage = "reserve";
    await dependencies.reserveDestination();
    destinationOwned = true;
    stage = "clone";
    await dependencies.cloneRepository();
    if (projectType === "nextjs") {
      stage = "scaffold";
      await dependencies.scaffoldNextApp();
    }
    stage = "optional-files";
    return { skippedFiles: await dependencies.addOptionalFiles() };
  } catch (error) {
    if (stage === "remote-check") throw error;
    let cleaned = false;
    if (destinationOwned) {
      try {
        await dependencies.removeDestination();
        cleaned = true;
      } catch {
        cleaned = false;
      }
    }
    throw new ProjectInitializationError(stageFailureMessage(stage, destinationOwned, cleaned), { cause: error });
  }
}
