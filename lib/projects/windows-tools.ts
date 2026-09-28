import "server-only";

import { execFile, spawn } from "node:child_process";
import { access, opendir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DISCOVERY_DIRECTORIES = 300;

type WindowsCommandName = "cursor" | "idea" | "idea64" | "powershell" | "wt";

export type ToolCandidate = {
  executable: string;
  source: string;
};

export type WindowsToolDiscovery = {
  candidate: ToolCandidate | null;
  attempts: string[];
};

async function isFile(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function discoverCommand(name: WindowsCommandName) {
  const command = `Get-Command -Name '${name}' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 4_000 },
    );
    const executable = stdout.trim().split(/\r?\n/)[0];
    return executable && await isFile(executable)
      ? { executable, source: `Get-Command ${name}` } satisfies ToolCandidate
      : null;
  } catch {
    return null;
  }
}

async function firstExisting(candidates: ToolCandidate[]) {
  for (const candidate of candidates) {
    if (await isFile(candidate.executable)) return candidate;
  }
  return null;
}

async function findNamedFile(root: string, fileName: string, maxDepth: number) {
  const matches: string[] = [];
  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_DISCOVERY_DIRECTORIES) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;
    try {
      const directory = await opendir(current.directory);
      for await (const entry of directory) {
        if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
          matches.push(path.join(current.directory, entry.name));
        } else if (entry.isDirectory() && !entry.isSymbolicLink() && current.depth < maxDepth) {
          queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
        }
      }
    } catch {
      // Missing or inaccessible installation directories are expected.
    }
  }

  return matches.sort((left, right) => right.localeCompare(left))[0] ?? null;
}

export async function discoverCursor(): Promise<WindowsToolDiscovery> {
  const attempts = [
    "Get-Command cursor",
    "%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe",
    "%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe",
    "%LOCALAPPDATA%\\Cursor\\Cursor.exe",
    "%ProgramFiles%\\Cursor\\Cursor.exe",
    "%ProgramFiles(x86)%\\Cursor\\Cursor.exe",
  ];
  if (process.platform !== "win32") return { candidate: null, attempts };

  const command = await discoverCommand("cursor");
  if (command) return { candidate: command, attempts };

  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const candidate = await firstExisting([
    ...(localAppData ? [
      { executable: path.join(localAppData, "Programs", "Cursor", "Cursor.exe"), source: "per-user install" },
      { executable: path.join(localAppData, "Programs", "cursor", "Cursor.exe"), source: "per-user install" },
      { executable: path.join(localAppData, "Cursor", "Cursor.exe"), source: "per-user install" },
    ] : []),
    ...(programFiles ? [{ executable: path.join(programFiles, "Cursor", "Cursor.exe"), source: "Program Files" }] : []),
    ...(programFilesX86 ? [{ executable: path.join(programFilesX86, "Cursor", "Cursor.exe"), source: "Program Files (x86)" }] : []),
  ]);
  return { candidate, attempts };
}

export async function discoverIntelliJ(): Promise<WindowsToolDiscovery> {
  const attempts = [
    "Get-Command idea64",
    "Get-Command idea",
    "%LOCALAPPDATA%\\JetBrains\\Toolbox\\scripts\\idea.cmd",
    "%LOCALAPPDATA%\\JetBrains\\Toolbox\\apps\\**\\idea64.exe",
    "%LOCALAPPDATA%\\Programs\\IntelliJ IDEA *\\bin\\idea64.exe",
    "%ProgramFiles%\\JetBrains\\IntelliJ IDEA *\\bin\\idea64.exe",
    "%ProgramFiles(x86)%\\JetBrains\\IntelliJ IDEA *\\bin\\idea64.exe",
  ];
  if (process.platform !== "win32") return { candidate: null, attempts };

  for (const name of ["idea64", "idea"] satisfies WindowsCommandName[]) {
    const command = await discoverCommand(name);
    if (command) return { candidate: command, attempts };
  }

  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const toolboxScript = localAppData
    ? await firstExisting([{ executable: path.join(localAppData, "JetBrains", "Toolbox", "scripts", "idea.cmd"), source: "JetBrains Toolbox script" }])
    : null;
  if (toolboxScript) return { candidate: toolboxScript, attempts };

  const searchRoots = [
    ...(localAppData ? [
      { root: path.join(localAppData, "JetBrains", "Toolbox", "apps"), depth: 6, source: "JetBrains Toolbox" },
      { root: path.join(localAppData, "Programs"), depth: 3, source: "per-user programs" },
    ] : []),
    ...(programFiles ? [{ root: path.join(programFiles, "JetBrains"), depth: 3, source: "Program Files" }] : []),
    ...(programFilesX86 ? [{ root: path.join(programFilesX86, "JetBrains"), depth: 3, source: "Program Files (x86)" }] : []),
  ];
  for (const search of searchRoots) {
    const executable = await findNamedFile(search.root, "idea64.exe", search.depth);
    if (executable) return { candidate: { executable, source: search.source }, attempts };
  }

  return { candidate: null, attempts };
}

export async function discoverWindowsTerminal(): Promise<WindowsToolDiscovery> {
  const attempts = ["Get-Command wt", "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe"];
  if (process.platform !== "win32") return { candidate: null, attempts };

  const command = await discoverCommand("wt");
  if (command) return { candidate: command, attempts };
  const localAppData = process.env.LOCALAPPDATA;
  const candidate = await firstExisting([
    ...(localAppData ? [{
      executable: path.join(localAppData, "Microsoft", "WindowsApps", "wt.exe"),
      source: "Windows Apps alias",
    }] : []),
  ]);
  return { candidate, attempts };
}

export async function discoverPowerShell(): Promise<WindowsToolDiscovery> {
  const attempts = ["Get-Command powershell", "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"];
  if (process.platform !== "win32") return { candidate: null, attempts };

  const command = await discoverCommand("powershell");
  if (command) return { candidate: command, attempts };
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const candidate = await firstExisting([
    ...(systemRoot ? [{
      executable: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      source: "Windows system directory",
    }] : []),
  ]);
  return { candidate, attempts };
}

export async function launchWindowsTool(candidate: ToolCandidate, args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const isCommandScript = /\.(?:cmd|bat)$/i.test(candidate.executable);
    const executable = isCommandScript
      ? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
      : candidate.executable;
    const launchArgs = isCommandScript
      ? ["/d", "/s", "/c", candidate.executable, ...args]
      : args;
    const child = spawn(/* turbopackIgnore: true */ executable, launchArgs, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function discoveryFailure(tool: string, attempts: string[]) {
  return `${tool} was not found. Checked: ${attempts.join("; ")}.`;
}
