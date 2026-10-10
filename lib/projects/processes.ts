import "server-only";

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import net from "node:net";
import { promisify } from "node:util";

import type { DevServerStatus, NodeLaunchMode, RepositoryActionResult } from "./action-types";
import { resolveNodeRuntime } from "./node-runtime";
import { findAvailablePort } from "./port-allocation";
import {
  classifyUnmanagedListener,
  collectWindowsProcessTree,
  listenerBelongsToWindowsLaunch,
  sameWindowsProcess,
  type WindowsProcessEvidence,
} from "./process-evidence";
import { classifySpringFailureOutput, redactRuntimeOutput } from "./runtime-config";
import { resolveSpringRuntime } from "./runtime-profile";
import { packageScriptCommand, requiresWindowsCommandShell, springLaunchArgs, springWrapperCommand } from "./service-commands";
import { serviceRuntimeKey } from "./service-resolution";
import type { ProjectService, Repository } from "@/lib/workspace/types";

const STARTUP_WAIT_MS = 8_000;
const STOP_WAIT_MS = 5_000;
const PORT_SEARCH_RANGE_SIZE = 20;
const MAX_OUTPUT_CHARS = 24_000;
const execFileAsync = promisify(execFile);

type ManagedProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  runtimeKey: string;
  serviceId: string;
  runtimeKind: "node" | "spring-boot";
  launchMode: NodeLaunchMode | null;
  startedAt: string;
  port: number | null;
  rootProcess: WindowsProcessEvidence | null;
  listenerProcess: WindowsProcessEvidence | null;
  output: string;
  redactions: string[];
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
  entry.output = redactRuntimeOutput(cleanOutput(`${entry.output}${chunk.toString()}`), entry.redactions).slice(-MAX_OUTPUT_CHARS);
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

function spawnPackageScript(service: ProjectService, script: "dev" | "build" | "start", environment: NodeJS.ProcessEnv): ChildProcessByStdio<null, Readable, Readable> {
  const command = packageScriptCommand(service, script);

  if (process.platform === "win32") {
    return spawn(/* turbopackIgnore: true */ process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command.executable, ...command.args], {
      cwd: service.path,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  return spawn(/* turbopackIgnore: true */ command.executable, command.args, {
    cwd: service.path,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function spawnSpringBoot(service: ProjectService, port: number, resolvedEnvironment: NodeJS.ProcessEnv): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const wrapper = springWrapperCommand(service, port);
  let executable = wrapper?.executable;
  let args = wrapper?.args;
  const buildTool = service.capabilities.javaBuildTool;
  if (!executable && process.platform === "win32") {
    const command = buildTool === "gradle" ? "gradle.bat" : "mvn.cmd";
    try {
      const { stdout } = await execFileAsync("where.exe", [command], { windowsHide: true, timeout: 3_000 });
      executable = stdout.trim().split(/\r?\n/)[0];
      if (!executable) throw new Error();
    } catch {
      const label = buildTool === "gradle" ? "Gradle" : "Maven";
      throw new Error(`${label} was not found and this service has no ${label} wrapper.`);
    }
    args = springLaunchArgs(service, port);
  } else if (!executable) {
    executable = buildTool === "gradle" ? "gradle" : "mvn";
    args = springLaunchArgs(service, port);
  }
  if (!executable || !args) throw new Error("The Spring Boot launch command could not be resolved.");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(resolvedEnvironment).filter(([name]) => name !== "PORT" && name !== "NODE_ENV"),
  ) as NodeJS.ProcessEnv;
  const environment: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    SERVER_PORT: String(port),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  if (requiresWindowsCommandShell(executable)) {
    return spawn(/* turbopackIgnore: true */ process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", executable, ...args], {
      cwd: service.path,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  return spawn(/* turbopackIgnore: true */ executable, args, {
    cwd: service.path,
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
    "Select-Object ProcessId,ParentProcessId,@{Name='CreationTime';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}},ExecutablePath,CommandLine",
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
      ExecutablePath: string | null;
      CommandLine: string | null;
    } | {
      ProcessId: number;
      ParentProcessId: number;
      CreationTime: string;
      ExecutablePath: string | null;
      CommandLine: string | null;
    }[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return new Map(rows.map((row) => [row.ProcessId, {
      pid: row.ProcessId,
      parentPid: row.ParentProcessId,
      creationTime: row.CreationTime,
      executablePath: row.ExecutablePath,
      commandLine: row.CommandLine,
    }]));
  } catch {
    return null;
  }
}

async function captureWindowsOwnership(entry: ManagedProcess) {
  if (process.platform !== "win32" || !entry.port) return false;
  const listenerPid = await findWindowsListenerPid(entry.port);
  const processes = await readWindowsProcessTable();
  if (!listenerPid || !processes) return false;

  const listener = processes.get(listenerPid);
  if (!listener) return false;
  if (!listenerBelongsToWindowsLaunch(listener, entry.rootProcess, entry.listenerProcess, processes)) {
    return false;
  }

  entry.listenerProcess = listener;
  return true;
}

async function finalizeExitedEntry(entry: ManagedProcess, exitCode: number | null) {
  if (runtime.processes.get(entry.runtimeKey) !== entry) return;
  if (entry.port && await isPortListening(entry.port)) {
    if (process.platform === "win32" && await captureWindowsOwnership(entry)) return;
    runtime.processes.delete(entry.runtimeKey);
    runtime.reservedPorts.delete(entry.port);
    return;
  }

  runtime.processes.delete(entry.runtimeKey);
  if (entry.port) runtime.reservedPorts.delete(entry.port);
  const processName = entry.runtimeKind === "spring-boot" ? "Backend" : entry.launchMode === "preview" ? "Preview server" : "Dev server";
  const classifiedMessage = entry.runtimeKind === "spring-boot" ? classifySpringFailureOutput(entry.output) : null;
  runtime.lastStatus.set(
    entry.runtimeKey,
    statusForEntry(entry, entry.stopping ? "stopped" : "failed", entry.stopping ? "Stopped" : classifiedMessage ?? `${processName} exited unexpectedly (code ${exitCode ?? "unknown"}).`),
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
    launchMode: entry.launchMode,
  };
}

export async function detectRunningDevServer(repository: Repository, service: ProjectService): Promise<DevServerStatus> {
  const key = serviceRuntimeKey(repository.id, service.id);
  const entry = runtime.processes.get(key);
  let possibleExternalPort = service.capabilities.devPortHint;
  if (entry) {
    possibleExternalPort = entry.port ?? possibleExternalPort;
    const listening = entry.port ? await isPortListening(entry.port) : false;
    if (listening) {
      const ownershipVerified = process.platform !== "win32" || await captureWindowsOwnership(entry);
      if (ownershipVerified) {
        return statusForEntry(entry, "running", `Running on localhost:${entry.port}`);
      }
      runtime.processes.delete(key);
      if (entry.port) runtime.reservedPorts.delete(entry.port);
    } else if (entry.child.exitCode === null && entry.child.signalCode === null) {
      return statusForEntry(entry, "starting", "DevHub process is starting.");
    } else {
      await finalizeExitedEntry(entry, entry.child.exitCode);
    }
  }

  const port = possibleExternalPort;
  if (port && await isPortListening(port)) {
    const listenerPid = await findWindowsListenerPid(port);
    const processes = await readWindowsProcessTable();
    const state = classifyUnmanagedListener(listenerPid, service.path, processes);
    if (state === "external") {
      return {
        state,
        ownedByDevHub: false,
        port,
        url: `http://localhost:${port}`,
        startedAt: null,
        message: `A matching service process is listening on localhost:${port}. DevHub did not start it and will not stop it.`,
        launchMode: null,
      };
    }
    return {
      state,
      ownedByDevHub: false,
      port,
      url: null,
      startedAt: null,
      message: `Port ${port} is being used by another process. DevHub will choose an available port when starting this service.`,
      launchMode: null,
    };
  }

  return runtime.lastStatus.get(key) ?? {
    state: "stopped",
    ownedByDevHub: false,
    port,
    url: null,
    startedAt: null,
    message: "Stopped",
    launchMode: null,
  };
}

async function runNodeBuild(service: ProjectService, environment: NodeJS.ProcessEnv, redactions: string[]) {
  const child = spawnPackageScript(service, "build", environment);
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = redactRuntimeOutput(cleanOutput(`${output}${chunk.toString()}`), redactions).slice(-MAX_OUTPUT_CHARS);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  return new Promise<{ ok: boolean; exitCode: number | null; output: string; message: string }>((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; exitCode: number | null; message: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ...result, output: outputExcerpt(output) });
    };
    const timeout = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        void execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
      finish({ ok: false, exitCode: child.exitCode, message: "The production build timed out after five minutes." });
    }, 300_000);
    child.once("error", (error) => {
      append(error.message);
      finish({ ok: false, exitCode: child.exitCode, message: "The production build could not be started." });
    });
    child.once("close", (exitCode) => finish({
      ok: exitCode === 0,
      exitCode,
      message: exitCode === 0 ? "Production build completed." : `Production build failed (exit ${exitCode ?? "unknown"}).`,
    }));
  });
}

async function startDevServerOnce(repository: Repository, service: ProjectService, launchMode: NodeLaunchMode): Promise<RepositoryActionResult> {
  const key = serviceRuntimeKey(repository.id, service.id);
  const runtimeKind = service.kind;
  if (runtimeKind === "spring-boot" && launchMode === "preview") {
    return { status: "error", message: "Preview mode is available for detected Next.js runtimes." };
  }
  const hasNodeDevScript = service.capabilities.packageScripts.includes("dev") && Boolean(service.capabilities.packageManager);
  const hasNodePreviewScripts = service.capabilities.packageScripts.includes("build")
    && service.capabilities.packageScripts.includes("start")
    && Boolean(service.capabilities.packageManager);
  if (runtimeKind === "node" && launchMode === "dev" && !hasNodeDevScript) {
    return { status: "error", message: "This repository does not expose a supported development runtime." };
  }
  if (runtimeKind === "node" && launchMode === "preview" && !hasNodePreviewScripts) {
    return { status: "error", message: "Preview requires detected build and start scripts." };
  }

  const current = await detectRunningDevServer(repository, service);
  if (current.state === "running" || current.state === "starting" || current.state === "external") {
    return {
      status: "running",
      message: current.state === "external" ? "Already running outside DevHub." : "Already running from DevHub.",
      devServer: current,
    };
  }

  const springRuntime = runtimeKind === "spring-boot" ? await resolveSpringRuntime(repository, service) : null;
  const nodeRuntime = runtimeKind === "node" ? await resolveNodeRuntime(service, launchMode) : null;
  if (springRuntime && !springRuntime.status.canStart) {
    return { status: "error", message: springRuntime.status.message ?? "Local prerequisites are not ready.", springRuntime: springRuntime.status };
  }

  const preferredPort = springRuntime?.preferredPort ?? service.capabilities.devPortHint ?? (runtimeKind === "spring-boot" ? 8080 : 3000);
  const port = await findAvailablePort(preferredPort, runtime.reservedPorts, isPortListening, PORT_SEARCH_RANGE_SIZE);
  if (!port) {
    return {
      status: "error",
      message: `No free local port was found from ${preferredPort} through ${Math.min(preferredPort + PORT_SEARCH_RANGE_SIZE - 1, 65_535)}.`,
      devServer: current.state === "port-in-use" ? current : undefined,
      springRuntime: springRuntime?.status,
      nodeRuntime: nodeRuntime?.status,
    };
  }

  const startedAt = new Date().toISOString();
  runtime.reservedPorts.add(port);
  let initialOutput = "";
  if (runtimeKind === "node" && launchMode === "preview" && nodeRuntime) {
    let build: Awaited<ReturnType<typeof runNodeBuild>>;
    try {
      build = await runNodeBuild(service, nodeRuntime.environment, nodeRuntime.redactions);
    } catch (error) {
      runtime.reservedPorts.delete(port);
      return {
        status: "error",
        message: error instanceof Error ? error.message : "The production build could not be started.",
        nodeRuntime: nodeRuntime.status,
      };
    }
    initialOutput = build.output;
    if (!build.ok) {
      runtime.reservedPorts.delete(port);
      return {
        status: "error",
        message: build.message,
        exitCode: build.exitCode,
        output: build.output || undefined,
        nodeRuntime: nodeRuntime.status,
      };
    }
  }
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = runtimeKind === "spring-boot"
      ? await spawnSpringBoot(service, port, springRuntime?.environment ?? process.env)
      : spawnPackageScript(service, launchMode === "preview" ? "start" : "dev", {
          ...nodeRuntime!.environment,
          PORT: String(port),
        } as NodeJS.ProcessEnv);
  } catch (error) {
    runtime.reservedPorts.delete(port);
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The allowlisted development command could not be started.",
      springRuntime: springRuntime?.status,
      nodeRuntime: nodeRuntime?.status,
    };
  }
  const entry: ManagedProcess = {
    child,
    runtimeKey: key,
    serviceId: service.id,
    runtimeKind,
    launchMode: runtimeKind === "node" ? launchMode : null,
    startedAt,
    port,
    rootProcess: null,
    listenerProcess: null,
    output: initialOutput,
    redactions: springRuntime?.redactions ?? nodeRuntime?.redactions ?? [],
    stopping: false,
  };
  runtime.processes.set(key, entry);
  runtime.lastStatus.delete(key);

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
    if (!runtime.processes.has(key)) {
      const failed = runtime.lastStatus.get(key) ?? await detectRunningDevServer(repository, service);
      return { status: "error", message: failed.message, exitCode: child.exitCode, output: failed.output, devServer: failed, springRuntime: springRuntime?.status, nodeRuntime: nodeRuntime?.status };
    }
    if (entry.port && await isPortListening(entry.port)) {
      if (process.platform === "win32" && !await captureWindowsOwnership(entry)) {
        const uncertain = statusForEntry(entry, "starting", "The local port opened, but DevHub could not verify that the listener belongs to its process tree.");
        return { status: "error", message: uncertain.message, output: uncertain.output, devServer: uncertain, springRuntime: springRuntime?.status };
      }
      const running = statusForEntry(entry, "running", `Running on localhost:${entry.port}`);
      return { status: "running", message: running.message, output: running.output, devServer: running, springRuntime: springRuntime?.status, nodeRuntime: nodeRuntime?.status };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await finalizeExitedEntry(entry, child.exitCode);
      const failed = runtime.lastStatus.get(key) ?? await detectRunningDevServer(repository, service);
      return { status: "error", message: failed.message, exitCode: child.exitCode, output: failed.output, devServer: failed, springRuntime: springRuntime?.status, nodeRuntime: nodeRuntime?.status };
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
  return { status: "running", message: starting.message, output: starting.output, devServer: starting, springRuntime: springRuntime?.status, nodeRuntime: nodeRuntime?.status };
}

export function startDevServer(repository: Repository, service: ProjectService): Promise<RepositoryActionResult> {
  return startServer(repository, service, "dev");
}

export function startPreviewServer(repository: Repository, service: ProjectService): Promise<RepositoryActionResult> {
  return startServer(repository, service, "preview");
}

function startServer(repository: Repository, service: ProjectService, launchMode: NodeLaunchMode): Promise<RepositoryActionResult> {
  const key = serviceRuntimeKey(repository.id, service.id);
  const inFlight = runtime.starts.get(key);
  if (inFlight) return inFlight;

  const start = startDevServerOnce(repository, service, launchMode).finally(() => {
    if (runtime.starts.get(key) === start) runtime.starts.delete(key);
  });
  runtime.starts.set(key, start);
  return start;
}

export async function stopDevServer(repository: Repository, service: ProjectService): Promise<RepositoryActionResult> {
  const key = serviceRuntimeKey(repository.id, service.id);
  const entry = runtime.processes.get(key);
  if (!entry) {
    return { status: "error", message: "No DevHub-owned process is running for this service." };
  }

  entry.stopping = true;
  if (process.platform === "win32") {
    const processes = await readWindowsProcessTable();
    const root = entry.rootProcess ? processes?.get(entry.rootProcess.pid) : null;
    const rootVerified = sameWindowsProcess(entry.rootProcess, root);
    const portListening = entry.port ? await isPortListening(entry.port) : false;
    const currentListenerPid = portListening && entry.port ? await findWindowsListenerPid(entry.port) : null;
    const currentListener = currentListenerPid ? processes?.get(currentListenerPid) : null;
    const listenerVerified = Boolean(processes && listenerBelongsToWindowsLaunch(
      currentListener,
      entry.rootProcess,
      entry.listenerProcess,
      processes,
    ));

    if (!processes || (portListening && !listenerVerified) || (!portListening && !rootVerified)) {
      entry.stopping = false;
      if (portListening) {
        runtime.processes.delete(key);
        if (entry.port) runtime.reservedPorts.delete(entry.port);
        const uncertain: DevServerStatus = {
          state: "port-in-use",
          ownedByDevHub: false,
          port: entry.port,
          url: null,
          startedAt: null,
          message: "DevHub could not verify ownership of the listening process, so it was not stopped.",
          launchMode: null,
        };
        return { status: "error", message: uncertain.message, output: outputExcerpt(entry.output), devServer: uncertain };
      }
      const uncertain = statusForEntry(entry, "starting", "DevHub could not verify its process identity, so it was not stopped.");
      return { status: "error", message: uncertain.message, output: uncertain.output, devServer: uncertain };
    }

    if (currentListener && !entry.listenerProcess) entry.listenerProcess = currentListener;
    const ownedProcesses = new Map<number, WindowsProcessEvidence>();
    if (rootVerified && entry.rootProcess) {
      for (const owned of collectWindowsProcessTree(entry.rootProcess.pid, processes)) ownedProcesses.set(owned.pid, owned);
    }
    if (currentListener) {
      for (const owned of collectWindowsProcessTree(currentListener.pid, processes)) ownedProcesses.set(owned.pid, owned);
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
      runtime.processes.set(key, entry);
      return { status: "error", message: stillRunning.message, output: stillRunning.output, devServer: stillRunning };
    }
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill();
  }

  runtime.processes.delete(key);
  if (entry.port) runtime.reservedPorts.delete(entry.port);
  const stopped = statusForEntry(entry, "stopped", "Stopped");
  stopped.url = null;
  runtime.lastStatus.set(key, stopped);
  return {
    status: "stopped",
    message: entry.runtimeKind === "spring-boot" ? "DevHub stopped its backend." : entry.launchMode === "preview" ? "DevHub stopped its preview process." : "DevHub stopped its dev process.",
    output: stopped.output,
    devServer: stopped,
  };
}
