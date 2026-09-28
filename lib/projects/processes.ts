import "server-only";

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import net from "node:net";
import { promisify } from "node:util";

import type { DevServerStatus, RepositoryActionResult } from "./action-types";
import type { PackageManager, Repository } from "@/lib/workspace/types";

const STARTUP_WAIT_MS = 8_000;
const STOP_WAIT_MS = 5_000;
const PORT_SEARCH_RANGE_SIZE = 20;
const MAX_OUTPUT_CHARS = 24_000;
const execFileAsync = promisify(execFile);

type WindowsProcessIdentity = {
  pid: number;
  parentPid: number;
  creationTime: string;
};

type ManagedProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  repositoryId: string;
  runtimeKind: "node" | "spring-boot";
  startedAt: string;
  port: number | null;
  rootProcess: WindowsProcessIdentity | null;
  listenerProcess: WindowsProcessIdentity | null;
  output: string;
  stopping: boolean;
};

type RuntimeStore = {
  processes: Map<string, ManagedProcess>;
  lastStatus: Map<string, DevServerStatus>;
  reservedPorts: Set<number>;
  starts: Map<string, Promise<RepositoryActionResult>>;
};

const runtimeGlobal = globalThis as typeof globalThis & { __devHubRuntime?: RuntimeStore };
const runtime = runtimeGlobal.__devHubRuntime ??= {
  processes: new Map(),
  lastStatus: new Map(),
  reservedPorts: new Set(),
  starts: new Map(),
};
runtime.reservedPorts ??= new Set();
runtime.starts ??= new Map();

function cleanOutput(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function appendOutput(entry: ManagedProcess, chunk: Buffer | string) {
  entry.output = cleanOutput(`${entry.output}${chunk.toString()}`).slice(-MAX_OUTPUT_CHARS);
  const matches = [...entry.output.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):([0-9]{1,5})/gi)];
  const detected = Number(matches.at(-1)?.[1]);
  if (detected >= 1 && detected <= 65_535 && entry.port !== detected) {
    if (entry.port) runtime.reservedPorts.delete(entry.port);
    entry.port = detected;
    runtime.reservedPorts.add(detected);
  }
}

function outputExcerpt(output: string) {
  return output.trim().split("\n").slice(-40).join("\n");
}

function packageCommand(packageManager: PackageManager, script: "dev") {
  const executable = `${packageManager}${process.platform === "win32" ? ".cmd" : ""}`;
  return { executable, args: packageManager === "npm" ? ["run", script] : [script] };
}

function spawnPackageScript(repository: Repository, port: number): ChildProcessByStdio<null, Readable, Readable> {
  const packageManager = repository.capabilities.packageManager;
  if (!packageManager) throw new Error("No supported package manager was detected.");
  const command = packageCommand(packageManager, "dev");
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", NO_COLOR: "1", FORCE_COLOR: "0" };
  childEnvironment.PORT = String(port);

  if (process.platform === "win32") {
    return spawn(/* turbopackIgnore: true */ process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command.executable, ...command.args], {
      cwd: repository.path,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  return spawn(/* turbopackIgnore: true */ command.executable, command.args, {
    cwd: repository.path,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function spawnSpringBoot(repository: Repository, port: number): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  let executable: string;
  if (repository.capabilities.hasMavenWrapper) {
    executable = process.platform === "win32" ? ".\\mvnw.cmd" : "./mvnw";
  } else if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("where.exe", ["mvn.cmd"], { windowsHide: true, timeout: 3_000 });
      executable = stdout.trim().split(/\r?\n/)[0];
      if (!executable) throw new Error();
    } catch {
      throw new Error("Maven was not found and this repository has no Maven wrapper.");
    }
  } else {
    executable = "mvn";
  }

  const args = ["spring-boot:run", `-Dspring-boot.run.arguments=--server.port=${port}`];
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "PORT" && name !== "NODE_ENV"),
  ) as NodeJS.ProcessEnv;
  const environment: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    SERVER_PORT: String(port),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    return spawn(/* turbopackIgnore: true */ process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", executable, ...args], {
      cwd: repository.path,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  return spawn(/* turbopackIgnore: true */ executable, args, {
    cwd: repository.path,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function isPortListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(450);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function findAvailablePort(preferredPort: number) {
  for (let offset = 0; offset < PORT_SEARCH_RANGE_SIZE; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65_535) break;
    if (!runtime.reservedPorts.has(port) && !await isPortListening(port)) return port;
  }
  return null;
}

async function findWindowsListenerPid(port: number) {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "TCP"], { windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue;
      const columns = line.trim().split(/\s+/);
      const localAddress = columns[1] ?? "";
      const pid = Number(columns.at(-1));
      if (localAddress.endsWith(`:${port}`) && Number.isSafeInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // Ownership remains unknown; Stop Dev will refuse to report success unless the port closes.
  }
  return null;
}

async function readWindowsProcessTable() {
  if (process.platform !== "win32") return null;
  const command = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,ParentProcessId,@{Name='CreationTime';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}}",
    "ConvertTo-Json -Compress",
  ].join(" | ");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      ProcessId: number;
      ParentProcessId: number;
      CreationTime: string;
    } | {
      ProcessId: number;
      ParentProcessId: number;
      CreationTime: string;
    }[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return new Map(rows.map((row) => [row.ProcessId, {
      pid: row.ProcessId,
      parentPid: row.ParentProcessId,
      creationTime: row.CreationTime,
    }]));
  } catch {
    return null;
  }
}

function sameWindowsProcess(left: WindowsProcessIdentity | undefined | null, right: WindowsProcessIdentity | undefined | null) {
  return Boolean(left && right && left.pid === right.pid && left.creationTime === right.creationTime);
}

function isDescendantOf(pid: number, ancestorPid: number, processes: Map<number, WindowsProcessIdentity>) {
  const visited = new Set<number>();
  let current = processes.get(pid);
  while (current && !visited.has(current.pid)) {
    if (current.pid === ancestorPid) return true;
    visited.add(current.pid);
    current = processes.get(current.parentPid);
  }
  return false;
}

function collectProcessTree(rootPid: number, processes: Map<number, WindowsProcessIdentity>) {
  return [...processes.values()].filter((candidate) => isDescendantOf(candidate.pid, rootPid, processes));
}

async function captureWindowsOwnership(entry: ManagedProcess) {
  if (process.platform !== "win32" || !entry.port) return false;
  const listenerPid = await findWindowsListenerPid(entry.port);
  const processes = await readWindowsProcessTable();
  if (!listenerPid || !processes) return false;

  const listener = processes.get(listenerPid);
  if (!listener) return false;
  if (sameWindowsProcess(entry.listenerProcess, listener)) return true;

  const rootPid = entry.child.pid;
  const root = rootPid ? processes.get(rootPid) : null;
  if (!rootPid || !sameWindowsProcess(entry.rootProcess, root) || !isDescendantOf(listenerPid, rootPid, processes)) {
    return false;
  }

  entry.listenerProcess = listener;
  return true;
}

async function finalizeExitedEntry(entry: ManagedProcess, exitCode: number | null) {
  if (runtime.processes.get(entry.repositoryId) !== entry) return;
  if (entry.port && await isPortListening(entry.port)) {
    if (process.platform === "win32" && await captureWindowsOwnership(entry)) return;
    runtime.processes.delete(entry.repositoryId);
    runtime.reservedPorts.delete(entry.port);
    return;
  }

  runtime.processes.delete(entry.repositoryId);
  if (entry.port) runtime.reservedPorts.delete(entry.port);
  const processName = entry.runtimeKind === "spring-boot" ? "Backend" : "Dev server";
  runtime.lastStatus.set(
    entry.repositoryId,
    statusForEntry(entry, entry.stopping ? "stopped" : "failed", entry.stopping ? "Stopped" : `${processName} exited with code ${exitCode ?? "unknown"}.`),
  );
}

function statusForEntry(entry: ManagedProcess, state: DevServerStatus["state"], message: string): DevServerStatus {
  const exposesLocalUrl = state === "running";
  return {
    state,
    ownedByDevHub: true,
    port: entry.port,
    url: exposesLocalUrl && entry.port ? `http://localhost:${entry.port}` : null,
    startedAt: entry.startedAt,
    message,
    output: outputExcerpt(entry.output) || undefined,
  };
}

export async function detectRunningDevServer(repository: Repository): Promise<DevServerStatus> {
  const entry = runtime.processes.get(repository.id);
  let possibleExternalPort = repository.capabilities.devPortHint;
  if (entry) {
    possibleExternalPort = entry.port ?? possibleExternalPort;
    const listening = entry.port ? await isPortListening(entry.port) : false;
    if (listening) {
      const ownershipVerified = process.platform !== "win32" || await captureWindowsOwnership(entry);
      if (ownershipVerified) {
        return statusForEntry(entry, "running", `Running on localhost:${entry.port}`);
      }
      runtime.processes.delete(repository.id);
      if (entry.port) runtime.reservedPorts.delete(entry.port);
    } else if (entry.child.exitCode === null && entry.child.signalCode === null) {
      return statusForEntry(entry, "starting", "DevHub process is starting.");
    } else {
      await finalizeExitedEntry(entry, entry.child.exitCode);
    }
  }

  const port = possibleExternalPort;
  if (port && await isPortListening(port)) {
    return {
      state: "port-in-use",
      ownedByDevHub: false,
      port,
      url: `http://localhost:${port}`,
      startedAt: null,
      message: `Port ${port} is already in use. DevHub will not claim or stop that process.`,
    };
  }

  return runtime.lastStatus.get(repository.id) ?? {
    state: "stopped",
    ownedByDevHub: false,
    port,
    url: null,
    startedAt: null,
    message: "Stopped",
  };
}

async function startDevServerOnce(repository: Repository): Promise<RepositoryActionResult> {
  const runtimeKind = repository.capabilities.hasSpringBoot ? "spring-boot" : "node";
  const hasNodeDevScript = repository.capabilities.packageScripts.includes("dev") && Boolean(repository.capabilities.packageManager);
  if (runtimeKind === "node" && !hasNodeDevScript) {
    return { status: "error", message: "This repository does not expose a supported development runtime." };
  }

  const current = await detectRunningDevServer(repository);
  if (current.state === "running" || current.state === "starting") {
    return { status: "running", message: "Already running from DevHub.", devServer: current };
  }

  const preferredPort = repository.capabilities.devPortHint ?? (runtimeKind === "spring-boot" ? 8080 : 3000);
  const port = await findAvailablePort(preferredPort);
  if (!port) {
    return {
      status: "error",
      message: `No free development port was found from ${preferredPort} through ${Math.min(preferredPort + PORT_SEARCH_RANGE_SIZE - 1, 65_535)}.`,
      devServer: current.state === "port-in-use" ? current : undefined,
    };
  }

  const startedAt = new Date().toISOString();
  runtime.reservedPorts.add(port);
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = runtimeKind === "spring-boot"
      ? await spawnSpringBoot(repository, port)
      : spawnPackageScript(repository, port);
  } catch (error) {
    runtime.reservedPorts.delete(port);
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The allowlisted development command could not be started.",
    };
  }
  const entry: ManagedProcess = {
    child,
    repositoryId: repository.id,
    runtimeKind,
    startedAt,
    port,
    rootProcess: null,
    listenerProcess: null,
    output: "",
    stopping: false,
  };
  runtime.processes.set(repository.id, entry);
  runtime.lastStatus.delete(repository.id);

  child.stdout.on("data", (chunk) => appendOutput(entry, chunk));
  child.stderr.on("data", (chunk) => appendOutput(entry, chunk));
  child.once("error", (error) => {
    appendOutput(entry, error.message);
    void finalizeExitedEntry(entry, child.exitCode);
  });
  child.once("close", (exitCode) => {
    void finalizeExitedEntry(entry, exitCode);
  });

  if (process.platform === "win32" && child.pid) {
    const processes = await readWindowsProcessTable();
    entry.rootProcess = processes?.get(child.pid) ?? null;
  }

  const deadline = Date.now() + (runtimeKind === "spring-boot" ? 30_000 : STARTUP_WAIT_MS);
  while (Date.now() < deadline) {
    if (!runtime.processes.has(repository.id)) {
      const failed = runtime.lastStatus.get(repository.id) ?? await detectRunningDevServer(repository);
      return { status: "error", message: failed.message, exitCode: child.exitCode, output: failed.output, devServer: failed };
    }
    if (entry.port && await isPortListening(entry.port)) {
      if (process.platform === "win32" && !await captureWindowsOwnership(entry)) {
        const uncertain = statusForEntry(entry, "starting", "The local port opened, but DevHub could not verify that the listener belongs to its process tree.");
        return { status: "error", message: uncertain.message, output: uncertain.output, devServer: uncertain };
      }
      const running = statusForEntry(entry, "running", `Running on localhost:${entry.port}`);
      return { status: "running", message: running.message, output: running.output, devServer: running };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await finalizeExitedEntry(entry, child.exitCode);
      const failed = runtime.lastStatus.get(repository.id) ?? await detectRunningDevServer(repository);
      return { status: "error", message: failed.message, exitCode: child.exitCode, output: failed.output, devServer: failed };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const starting = statusForEntry(
    entry,
    "starting",
    runtimeKind === "spring-boot"
      ? "DevHub started the backend; waiting for its local port."
      : "DevHub started the process; waiting for a local URL.",
  );
  return { status: "running", message: starting.message, output: starting.output, devServer: starting };
}

export function startDevServer(repository: Repository): Promise<RepositoryActionResult> {
  const inFlight = runtime.starts.get(repository.id);
  if (inFlight) return inFlight;

  const start = startDevServerOnce(repository).finally(() => {
    if (runtime.starts.get(repository.id) === start) runtime.starts.delete(repository.id);
  });
  runtime.starts.set(repository.id, start);
  return start;
}

export async function stopDevServer(repository: Repository): Promise<RepositoryActionResult> {
  const entry = runtime.processes.get(repository.id);
  if (!entry) {
    return { status: "error", message: "No DevHub-owned dev process is running for this repository." };
  }

  entry.stopping = true;
  if (process.platform === "win32") {
    const processes = await readWindowsProcessTable();
    const root = entry.rootProcess ? processes?.get(entry.rootProcess.pid) : null;
    const rootVerified = sameWindowsProcess(entry.rootProcess, root);
    const portListening = entry.port ? await isPortListening(entry.port) : false;
    const currentListenerPid = portListening && entry.port ? await findWindowsListenerPid(entry.port) : null;
    const currentListener = currentListenerPid ? processes?.get(currentListenerPid) : null;
    const listenerVerified = sameWindowsProcess(entry.listenerProcess, currentListener)
      || Boolean(rootVerified && currentListenerPid && entry.rootProcess && processes
        && isDescendantOf(currentListenerPid, entry.rootProcess.pid, processes));

    if (!processes || (portListening && !listenerVerified) || (!portListening && !rootVerified)) {
      entry.stopping = false;
      if (portListening) {
        runtime.processes.delete(repository.id);
        if (entry.port) runtime.reservedPorts.delete(entry.port);
        const uncertain: DevServerStatus = {
          state: "port-in-use",
          ownedByDevHub: false,
          port: entry.port,
          url: entry.port ? `http://localhost:${entry.port}` : null,
          startedAt: null,
          message: "DevHub could not verify ownership of the listening process, so it was not stopped.",
        };
        return { status: "error", message: uncertain.message, output: outputExcerpt(entry.output), devServer: uncertain };
      }
      const uncertain = statusForEntry(entry, "starting", "DevHub could not verify its process identity, so it was not stopped.");
      return { status: "error", message: uncertain.message, output: uncertain.output, devServer: uncertain };
    }

    if (currentListener && !entry.listenerProcess) entry.listenerProcess = currentListener;
    const ownedProcesses = new Map<number, WindowsProcessIdentity>();
    if (rootVerified && entry.rootProcess) {
      for (const owned of collectProcessTree(entry.rootProcess.pid, processes)) ownedProcesses.set(owned.pid, owned);
    }
    if (currentListener) {
      for (const owned of collectProcessTree(currentListener.pid, processes)) ownedProcesses.set(owned.pid, owned);
    }

    const killTree = async (pid: number) => {
      try {
        await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      } catch {
        // Verification below decides whether the owned tree was actually stopped.
      }
    };
    if (currentListener) await killTree(currentListener.pid);
    if (rootVerified && entry.rootProcess && entry.rootProcess.pid !== currentListener?.pid) {
      await killTree(entry.rootProcess.pid);
    }

    const deadline = Date.now() + STOP_WAIT_MS;
    let portStillListening = entry.port ? await isPortListening(entry.port) : false;
    let ownedStillRunning = true;
    while (Date.now() < deadline) {
      const currentProcesses = await readWindowsProcessTable();
      ownedStillRunning = !currentProcesses || [...ownedProcesses.values()].some(
        (owned) => sameWindowsProcess(owned, currentProcesses.get(owned.pid)),
      );
      portStillListening = entry.port ? await isPortListening(entry.port) : false;
      if (!ownedStillRunning && !portStillListening) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (ownedStillRunning || portStillListening) {
      entry.stopping = false;
      const state = portStillListening ? "running" : "starting";
      const failed = statusForEntry(
        entry,
        state,
        portStillListening
          ? `DevHub could not close localhost:${entry.port}.`
          : "The port closed, but DevHub could not verify that its complete process tree stopped.",
      );
      return { status: "error", message: failed.message, output: failed.output, devServer: failed };
    }
  } else {
    entry.child.kill("SIGTERM");
    const deadline = Date.now() + STOP_WAIT_MS;
    while (entry.port && Date.now() < deadline && await isPortListening(entry.port)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (entry.port && await isPortListening(entry.port)) {
      entry.stopping = false;
      const stillRunning = statusForEntry(entry, "running", `DevHub could not stop its process on localhost:${entry.port}.`);
      runtime.processes.set(repository.id, entry);
      return { status: "error", message: stillRunning.message, output: stillRunning.output, devServer: stillRunning };
    }
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill();
  }

  runtime.processes.delete(repository.id);
  if (entry.port) runtime.reservedPorts.delete(entry.port);
  const stopped = statusForEntry(entry, "stopped", "Stopped");
  stopped.url = null;
  runtime.lastStatus.set(repository.id, stopped);
  return {
    status: "stopped",
    message: entry.runtimeKind === "spring-boot" ? "DevHub stopped its backend." : "DevHub stopped its dev process.",
    output: stopped.output,
    devServer: stopped,
  };
}
