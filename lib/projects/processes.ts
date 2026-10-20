import "server-only";

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { isAbsolute as pathIsAbsolute } from "node:path";
import type { Readable } from "node:stream";
import net from "node:net";
import { promisify } from "node:util";

import type { DevServerStatus, HistoricalProcessFailure, NodeLaunchMode, RepositoryActionResult } from "./action-types";
import { resolveNodeRuntime } from "./node-runtime";
import { findAvailablePort } from "./port-allocation";
import { classifyManagedProcessExit, managedStartupSignal } from "./process-exit";
import {
  classifyUnmanagedListener,
  collectWindowsProcessTree,
  consistentWindowsListenerSnapshot,
  listenerBelongsToWindowsLaunch,
  sameWindowsProcess,
  survivingWindowsProcesses,
  windowsProcessExitIsConclusive,
  type WindowsProcessEvidence,
} from "./process-evidence";
import { trackedRuntimePort } from "./process-output";
import { clearHistoricalProcessOwnership } from "./process-status";
import { trustedGracefulStopPolicy, unverifiedWindowsOwnershipPolicy } from "./process-lifecycle-policy";
import { createNodeProcessEnvironment } from "./runtime-environment";
import { classifySpringFailureOutput, redactRuntimeOutput } from "./runtime-config";
import { resolveSpringRuntime } from "./runtime-profile";
import { nextPackageScriptCommand, packageScriptCommand, requiresWindowsCommandShell, springLaunchArgs, springWrapperCommand } from "./service-commands";
import { serviceRuntimeKey } from "./service-resolution";
import type { ProjectService, Repository } from "@/lib/workspace/types";

const STARTUP_WAIT_MS = 8_000;
const STOP_WAIT_MS = 5_000;
const PORT_SEARCH_RANGE_SIZE = 20;
const MAX_OUTPUT_CHARS = 24_000;
const WINDOWS_OWNERSHIP_ATTEMPTS = 3;
const execFileAsync = promisify(execFile);

type ManagedProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  runtimeKey: string;
  serviceId: string;
  runtimeKind: "node" | "spring-boot" | "process";
  launchMode: NodeLaunchMode | null;
  startedAt: string;
  port: number | null;
  rootProcess: WindowsProcessEvidence | null;
  listenerProcess: WindowsProcessEvidence | null;
  ownedProcesses: Map<number, WindowsProcessEvidence>;
  ownershipCaptureComplete: boolean;
  output: string;
  redactions: string[];
  stopping: boolean;
  host: string;
};

export type ServiceRuntimeOptions = {
  runtimeScope?: string;
  fixedPort?: number;
  host?: string;
  environment?: NodeJS.ProcessEnv;
  redactions?: string[];
  springProfile?: string | null;
};

type RuntimeStore = {
  processes: Map<string, ManagedProcess>;
  lastStatus: Map<string, DevServerStatus>;
  failures: Map<string, HistoricalProcessFailure>;
  reservedPorts: Set<number>;
  starts: Map<string, Promise<RepositoryActionResult>>;
};

const runtimeGlobal = globalThis as typeof globalThis & { __devHubRuntime?: RuntimeStore };
const runtime = runtimeGlobal.__devHubRuntime ??= {
  processes: new Map(),
  lastStatus: new Map(),
  failures: new Map(),
  reservedPorts: new Set(),
  starts: new Map(),
};
runtime.reservedPorts ??= new Set();
runtime.starts ??= new Map();
runtime.failures ??= new Map();

function cleanOutput(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function appendOutput(entry: ManagedProcess, chunk: Buffer | string) {
  entry.output = redactRuntimeOutput(cleanOutput(`${entry.output}${chunk.toString()}`), entry.redactions).slice(-MAX_OUTPUT_CHARS);
  const detected = trackedRuntimePort(entry.port, entry.output);
  if (detected && entry.port !== detected) {
    if (entry.port) runtime.reservedPorts.delete(entry.port);
    entry.port = detected;
    runtime.reservedPorts.add(detected);
  }
}

function outputExcerpt(output: string) {
  return output.trim().split("\n").slice(-40).join("\n");
}

function spawnPackageScript(
  service: ProjectService,
  script: "dev" | "build" | "start",
  environment: NodeJS.ProcessEnv,
  binding?: { hostname: string; port: number },
): ChildProcessByStdio<null, Readable, Readable> {
  const command = binding && script !== "build" && service.technologies.some((technology) => technology.name === "Next.js")
    ? nextPackageScriptCommand(service, script, binding.hostname, binding.port)
    : packageScriptCommand(service, script);

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

async function spawnSpringBoot(service: ProjectService, port: number, host: string, resolvedEnvironment: NodeJS.ProcessEnv, springProfile: string | null): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const wrapper = springWrapperCommand(service, port, process.platform, springProfile);
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
    args = springLaunchArgs(service, port, springProfile);
  } else if (!executable) {
    executable = buildTool === "gradle" ? "gradle" : "mvn";
    args = springLaunchArgs(service, port, springProfile);
  }
  if (!executable || !args) throw new Error("The Spring Boot launch command could not be resolved.");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(resolvedEnvironment).filter(([name]) => name !== "PORT" && name !== "NODE_ENV"),
  ) as NodeJS.ProcessEnv;
  const environment: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    SERVER_PORT: String(port),
    SERVER_ADDRESS: host,
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

async function readWindowsProcessTableWithRetry() {
  for (let attempt = 0; attempt < WINDOWS_OWNERSHIP_ATTEMPTS; attempt += 1) {
    const processes = await readWindowsProcessTable();
    if (processes) return processes;
    if (attempt + 1 < WINDOWS_OWNERSHIP_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  return null;
}

async function readWindowsListenerSnapshot(port: number) {
  for (let attempt = 0; attempt < WINDOWS_OWNERSHIP_ATTEMPTS; attempt += 1) {
    const listenerPidBefore = await findWindowsListenerPid(port);
    const processes = await readWindowsProcessTable();
    const listenerPidAfter = await findWindowsListenerPid(port);
    const snapshot = consistentWindowsListenerSnapshot(listenerPidBefore, listenerPidAfter, processes);
    if (snapshot) return snapshot;
    if (attempt + 1 < WINDOWS_OWNERSHIP_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  return null;
}

async function captureWindowsOwnership(entry: ManagedProcess) {
  if (process.platform !== "win32" || !entry.port) return false;
  const snapshot = await readWindowsListenerSnapshot(entry.port);
  if (!snapshot) return false;
  if (!listenerBelongsToWindowsLaunch(snapshot.listener, entry.rootProcess, entry.listenerProcess, snapshot.processes)) {
    return false;
  }

  entry.listenerProcess = snapshot.listener;
  entry.ownedProcesses.set(snapshot.listener.pid, snapshot.listener);
  if (entry.rootProcess && sameWindowsProcess(entry.rootProcess, snapshot.processes.get(entry.rootProcess.pid))) {
    for (const owned of collectWindowsProcessTree(entry.rootProcess.pid, snapshot.processes)) entry.ownedProcesses.set(owned.pid, owned);
  }
  return true;
}

function stoppedStatusForEntry(entry: ManagedProcess, historicalFailure: HistoricalProcessFailure | null = null): DevServerStatus {
  return {
    state: "stopped",
    ownedByDevHub: false,
    port: entry.port,
    url: null,
    startedAt: entry.startedAt,
    message: "Stopped",
    historicalFailure,
    launchMode: entry.launchMode,
  };
}

function recordUnexpectedFailure(entry: ManagedProcess, exitCode: number | null) {
  const existing = runtime.failures.get(entry.runtimeKey);
  if (existing) return existing;
  const processName = entry.runtimeKind === "spring-boot" ? "Backend" : entry.runtimeKind === "process" ? "Local process" : entry.launchMode === "preview" ? "Preview server" : "Dev server";
  const classifiedMessage = entry.runtimeKind === "spring-boot" ? classifySpringFailureOutput(entry.output) : null;
  const exit = classifyManagedProcessExit(false, exitCode, processName, classifiedMessage);
  const historicalFailure = {
    message: exit.message,
    output: outputExcerpt(entry.output) || undefined,
    exitCode: exit.exitCode,
    failedAt: new Date().toISOString(),
  } satisfies HistoricalProcessFailure;
  runtime.failures.set(entry.runtimeKey, historicalFailure);
  return historicalFailure;
}

async function finalizeExitedEntry(entry: ManagedProcess, exitCode: number | null) {
  if (runtime.processes.get(entry.runtimeKey) !== entry) return true;
  if (entry.port && await isPortListening(entry.port)) {
    if (process.platform === "win32" && await captureWindowsOwnership(entry)) return false;
    if (process.platform === "win32") return false;
    runtime.processes.delete(entry.runtimeKey);
    runtime.reservedPorts.delete(entry.port);
    return true;
  }
  const historicalFailure = entry.stopping ? null : recordUnexpectedFailure(entry, exitCode);
  if (process.platform === "win32") {
    if (!entry.ownershipCaptureComplete || !entry.rootProcess) return false;
    const processes = await readWindowsProcessTableWithRetry();
    if (processes && sameWindowsProcess(entry.rootProcess, processes.get(entry.rootProcess.pid))) {
      for (const owned of collectWindowsProcessTree(entry.rootProcess.pid, processes)) entry.ownedProcesses.set(owned.pid, owned);
    }
    if (!processes || !windowsProcessExitIsConclusive(entry.rootProcess, entry.ownedProcesses, processes)) return false;
  }

  runtime.processes.delete(entry.runtimeKey);
  if (entry.port) runtime.reservedPorts.delete(entry.port);
  if (historicalFailure) {
    runtime.lastStatus.set(entry.runtimeKey, stoppedStatusForEntry(entry, historicalFailure));
  } else {
    runtime.lastStatus.set(entry.runtimeKey, {
      ...stoppedStatusForEntry(entry, runtime.failures.get(entry.runtimeKey) ?? null),
      exitClassification: "managed-stop",
      exitCode,
    });
  }
  return true;
}

function statusForEntry(
  entry: ManagedProcess,
  state: DevServerStatus["state"],
  message: string,
  exit: Pick<DevServerStatus, "exitClassification" | "exitCode"> = {},
): DevServerStatus {
  const exposesLocalUrl = state === "running";
  return {
    state,
    ownedByDevHub: true,
    port: entry.port,
    url: exposesLocalUrl && entry.port ? `http://${entry.host}:${entry.port}` : null,
    startedAt: entry.startedAt,
    message,
    output: outputExcerpt(entry.output) || undefined,
    historicalFailure: runtime.failures.get(entry.runtimeKey) ?? null,
    ...exit,
    launchMode: entry.launchMode,
  };
}

async function detectManagedRuntime(key: string, servicePath: string, possibleExternalPort: number | null, host: string): Promise<DevServerStatus> {
  const entry = runtime.processes.get(key);
  if (entry) {
    possibleExternalPort = entry.port ?? possibleExternalPort;
    const listening = entry.port ? await isPortListening(entry.port) : false;
    const startupSignal = managedStartupSignal(entry.child.exitCode !== null || entry.child.signalCode !== null, listening);
    if (startupSignal === "exited") {
      await finalizeExitedEntry(entry, entry.child.exitCode);
      if (runtime.processes.get(key) === entry) {
        return statusForEntry(entry, "failed", "The process wrapper exited before readiness, but a verified or unverifiable process from its launch tree may still be running.");
      }
    } else if (startupSignal === "ready") {
      const ownershipVerified = process.platform !== "win32" || await captureWindowsOwnership(entry);
      if (ownershipVerified) {
        return statusForEntry(entry, "running", `Running on localhost:${entry.port}`);
      }
      const uncertain = unverifiedWindowsOwnershipPolicy(true);
      return statusForEntry(entry, "failed", uncertain.message);
    } else {
      return statusForEntry(entry, "starting", "DevHub process is starting.");
    }
  }

  const port = possibleExternalPort;
  if (port && await isPortListening(port)) {
    const listenerPid = await findWindowsListenerPid(port);
    const processes = await readWindowsProcessTable();
    const state = classifyUnmanagedListener(listenerPid, servicePath, processes);
    if (state === "external") {
      return {
        state,
        ownedByDevHub: false,
        port,
        url: `http://${host}:${port}`,
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

  const retained = runtime.lastStatus.get(key);
  if (retained) {
    const normalized = clearHistoricalProcessOwnership(retained);
    if (normalized !== retained) {
      runtime.lastStatus.set(key, normalized);
      if (normalized.historicalFailure) runtime.failures.set(key, normalized.historicalFailure);
    }
    return normalized;
  }
  return {
    state: "stopped",
    ownedByDevHub: false,
    port,
    url: null,
    startedAt: null,
    message: "Stopped",
    historicalFailure: runtime.failures.get(key) ?? null,
    launchMode: null,
  };
}

export async function detectRunningDevServer(repository: Repository, service: ProjectService, options: ServiceRuntimeOptions = {}): Promise<DevServerStatus> {
  return detectManagedRuntime(
    serviceRuntimeKey(repository.id, service.id, options.runtimeScope),
    service.path,
    options.fixedPort ?? service.capabilities.devPortHint,
    options.host ?? "localhost",
  );
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

async function startDevServerOnce(repository: Repository, service: ProjectService, launchMode: NodeLaunchMode, options: ServiceRuntimeOptions): Promise<RepositoryActionResult> {
  const key = serviceRuntimeKey(repository.id, service.id, options.runtimeScope);
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

  const current = await detectRunningDevServer(repository, service, options);
  if (current.state === "running" || current.state === "starting" || current.state === "external") {
    return {
      status: "running",
      message: current.state === "external" ? "Already running outside DevHub." : "Already running from DevHub.",
      devServer: current,
    };
  }

  const springRuntime = runtimeKind === "spring-boot" ? await resolveSpringRuntime(repository, service, options.environment, options.springProfile) : null;
  const nodeRuntime = runtimeKind === "node" ? await resolveNodeRuntime(service, launchMode) : null;
  if (springRuntime && !springRuntime.status.canStart) {
    return { status: "error", message: springRuntime.status.message ?? "Local prerequisites are not ready.", springRuntime: springRuntime.status };
  }

  const preferredPort = options.fixedPort ?? springRuntime?.preferredPort ?? service.capabilities.devPortHint ?? (runtimeKind === "spring-boot" ? 8080 : 3000);
  const port = options.fixedPort
    ? (!runtime.reservedPorts.has(options.fixedPort) && !await isPortListening(options.fixedPort) ? options.fixedPort : null)
    : await findAvailablePort(preferredPort, runtime.reservedPorts, isPortListening, PORT_SEARCH_RANGE_SIZE);
  if (!port) {
    return {
      status: "error",
      message: options.fixedPort
        ? `Required fixed port ${preferredPort} is unavailable.`
        : `No free local port was found from ${preferredPort} through ${Math.min(preferredPort + PORT_SEARCH_RANGE_SIZE - 1, 65_535)}.`,
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
      build = await runNodeBuild(
        service,
        createNodeProcessEnvironment(nodeRuntime.environment, options.environment),
        [...new Set([...nodeRuntime.redactions, ...(options.redactions ?? [])])],
      );
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
      ? await spawnSpringBoot(service, port, options.host ?? "127.0.0.1", { ...(springRuntime?.environment ?? process.env), ...options.environment }, springRuntime?.springProfile ?? null)
      : spawnPackageScript(
          service,
          launchMode === "preview" ? "start" : "dev",
          createNodeProcessEnvironment(nodeRuntime!.environment, options.environment, {
            port,
            ...(options.host ? { host: options.host } : {}),
          }),
          options.host ? { hostname: options.host, port } : undefined,
        );
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
    ownedProcesses: new Map(),
    ownershipCaptureComplete: process.platform !== "win32",
    output: initialOutput,
    redactions: [...new Set([...(springRuntime?.redactions ?? nodeRuntime?.redactions ?? []), ...(options.redactions ?? [])])],
    stopping: false,
    host: options.host ?? "localhost",
  };
  runtime.processes.set(key, entry);
  runtime.lastStatus.delete(key);
  runtime.failures.delete(key);

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
    const processes = await readWindowsProcessTableWithRetry();
    entry.rootProcess = processes?.get(child.pid) ?? null;
    if (entry.rootProcess && processes) {
      for (const owned of collectWindowsProcessTree(entry.rootProcess.pid, processes)) entry.ownedProcesses.set(owned.pid, owned);
    }
    entry.ownershipCaptureComplete = true;
  }

  const deadline = Date.now() + (runtimeKind === "spring-boot" ? 30_000 : STARTUP_WAIT_MS);
  while (Date.now() < deadline) {
    if (!runtime.processes.has(key)) {
      const failed = runtime.lastStatus.get(key) ?? await detectRunningDevServer(repository, service, options);
      const historical = failed.historicalFailure;
      return { status: "error", message: historical?.message ?? failed.message, exitCode: historical?.exitCode ?? child.exitCode, output: historical?.output ?? failed.output, devServer: failed, springRuntime: springRuntime?.status, nodeRuntime: nodeRuntime?.status };
    }
    const listening = entry.port ? await isPortListening(entry.port) : false;
    const startupSignal = managedStartupSignal(child.exitCode !== null || child.signalCode !== null, listening);
    if (startupSignal === "exited") {
      const finalized = await finalizeExitedEntry(entry, child.exitCode);
      if (!finalized) {
        return { status: "error", message: "The process wrapper exited before readiness, but DevHub still detects a verified process from its launch tree.", output: outputExcerpt(entry.output), devServer: statusForEntry(entry, "failed", "The process wrapper exited before readiness, but a verified process from its launch tree is still running."), springRuntime: springRuntime?.status, nodeRuntime: nodeRuntime?.status };
      }
      const failed = runtime.lastStatus.get(key) ?? await detectRunningDevServer(repository, service, options);
      const historical = failed.historicalFailure;
      return { status: "error", message: historical?.message ?? failed.message, exitCode: historical?.exitCode ?? child.exitCode, output: historical?.output ?? failed.output, devServer: failed, springRuntime: springRuntime?.status, nodeRuntime: nodeRuntime?.status };
    }
    if (startupSignal === "ready") {
      if (process.platform === "win32" && !await captureWindowsOwnership(entry)) {
        const uncertain = statusForEntry(entry, "starting", "The local port opened, but DevHub could not verify that the listener belongs to its process tree.");
        return { status: "error", message: uncertain.message, output: uncertain.output, devServer: uncertain, springRuntime: springRuntime?.status };
      }
      const running = statusForEntry(entry, "running", `Running on localhost:${entry.port}`);
      return { status: "running", message: running.message, output: running.output, devServer: running, springRuntime: springRuntime?.status, nodeRuntime: nodeRuntime?.status };
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

export function startDevServer(repository: Repository, service: ProjectService, options: ServiceRuntimeOptions = {}): Promise<RepositoryActionResult> {
  return startServer(repository, service, "dev", options);
}

export function startPreviewServer(repository: Repository, service: ProjectService, options: ServiceRuntimeOptions = {}): Promise<RepositoryActionResult> {
  return startServer(repository, service, "preview", options);
}

function startServer(repository: Repository, service: ProjectService, launchMode: NodeLaunchMode, options: ServiceRuntimeOptions): Promise<RepositoryActionResult> {
  const key = serviceRuntimeKey(repository.id, service.id, options.runtimeScope);
  const inFlight = runtime.starts.get(key);
  if (inFlight) return inFlight;

  const start = startDevServerOnce(repository, service, launchMode, options).finally(() => {
    if (runtime.starts.get(key) === start) runtime.starts.delete(key);
  });
  runtime.starts.set(key, start);
  return start;
}

export type TrustedManagedCommand = {
  runtimeKey: string;
  serviceId: string;
  servicePath: string;
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  redactions: string[];
  port: number;
  host: string;
  gracefulStop?: { executable: string; args: string[] } | null;
};

function spawnTrustedCommand(command: TrustedManagedCommand) {
  if (!command.executable.trim() || !command.cwd || !pathIsAbsolute(command.cwd)) throw new Error("Trusted process metadata is invalid.");
  if (requiresWindowsCommandShell(command.executable)) {
    return spawn(/* turbopackIgnore: true */ process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command.executable, ...command.args], {
      cwd: command.cwd,
      env: command.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn(/* turbopackIgnore: true */ command.executable, command.args, {
    cwd: command.cwd,
    env: command.environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  });
}

export function detectTrustedManagedProcess(command: TrustedManagedCommand) {
  return detectManagedRuntime(command.runtimeKey, command.servicePath, command.port, command.host);
}

export async function startTrustedManagedProcess(command: TrustedManagedCommand): Promise<RepositoryActionResult> {
  const current = await detectTrustedManagedProcess(command);
  if (current.state === "running" || current.state === "starting" || current.state === "external") {
    return { status: "running", message: current.state === "external" ? "Already running outside DevHub." : "Already running from DevHub.", devServer: current };
  }
  if (runtime.reservedPorts.has(command.port) || await isPortListening(command.port)) {
    return { status: "error", message: `Required fixed port ${command.port} is unavailable.`, devServer: current.state === "port-in-use" ? current : undefined };
  }
  runtime.reservedPorts.add(command.port);
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawnTrustedCommand(command);
  } catch (error) {
    runtime.reservedPorts.delete(command.port);
    return { status: "error", message: error instanceof Error ? error.message : "The trusted local process could not be started." };
  }
  const entry: ManagedProcess = {
    child,
    runtimeKey: command.runtimeKey,
    serviceId: command.serviceId,
    runtimeKind: "process",
    launchMode: null,
    startedAt: new Date().toISOString(),
    port: command.port,
    rootProcess: null,
    listenerProcess: null,
    ownedProcesses: new Map(),
    ownershipCaptureComplete: process.platform !== "win32",
    output: "",
    redactions: command.redactions,
    stopping: false,
    host: command.host,
  };
  runtime.processes.set(command.runtimeKey, entry);
  runtime.lastStatus.delete(command.runtimeKey);
  runtime.failures.delete(command.runtimeKey);
  child.stdout.on("data", (chunk) => appendOutput(entry, chunk));
  child.stderr.on("data", (chunk) => appendOutput(entry, chunk));
  child.once("error", (error) => {
    appendOutput(entry, error.message);
    void finalizeExitedEntry(entry, child.exitCode);
  });
  child.once("close", (exitCode) => void finalizeExitedEntry(entry, exitCode));
  if (process.platform === "win32" && child.pid) {
    const processes = await readWindowsProcessTableWithRetry();
    entry.rootProcess = processes?.get(child.pid) ?? null;
    if (entry.rootProcess && processes) {
      for (const owned of collectWindowsProcessTree(entry.rootProcess.pid, processes)) entry.ownedProcesses.set(owned.pid, owned);
    }
    entry.ownershipCaptureComplete = true;
  }
  const deadline = Date.now() + STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    const listening = await isPortListening(command.port);
    const startupSignal = managedStartupSignal(child.exitCode !== null || child.signalCode !== null, listening);
    if (startupSignal === "exited") {
      const finalized = await finalizeExitedEntry(entry, child.exitCode);
      if (!finalized) {
        const failed = statusForEntry(entry, "failed", "The process wrapper exited before readiness, but a verified process from its launch tree is still running.");
        return { status: "error", message: failed.message, output: failed.output, devServer: failed };
      }
      const failed = runtime.lastStatus.get(command.runtimeKey);
      return { status: "error", message: failed?.historicalFailure?.message ?? failed?.message ?? "The trusted local process exited before becoming ready.", output: failed?.historicalFailure?.output ?? failed?.output, devServer: failed };
    }
    if (startupSignal === "ready") {
      if (process.platform === "win32" && !await captureWindowsOwnership(entry)) {
        const uncertain = statusForEntry(entry, "starting", "The fixed port opened, but DevHub could not verify the listener ownership.");
        return { status: "error", message: uncertain.message, devServer: uncertain };
      }
      const running = statusForEntry(entry, "running", `Running on ${command.host}:${command.port}`);
      return { status: "running", message: running.message, devServer: running };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const starting = statusForEntry(entry, "starting", "DevHub started the trusted local process; waiting for its fixed port.");
  return { status: "running", message: starting.message, devServer: starting };
}

async function runTrustedStopCommand(command: TrustedManagedCommand) {
  if (!command.gracefulStop) return;
  const stop = command.gracefulStop;
  const executable = requiresWindowsCommandShell(stop.executable)
    ? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
    : stop.executable;
  const args = requiresWindowsCommandShell(stop.executable)
    ? ["/d", "/s", "/c", stop.executable, ...stop.args]
    : stop.args;
  await execFileAsync(executable, args, {
    cwd: command.cwd,
    env: command.environment,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

async function canRunTrustedGracefulStop(entry: ManagedProcess) {
  if (process.platform !== "win32") return true;
  if (!entry.port || !await isPortListening(entry.port)) return false;
  const listenerSnapshot = await readWindowsListenerSnapshot(entry.port);
  const listenerVerified = Boolean(listenerSnapshot && listenerBelongsToWindowsLaunch(
    listenerSnapshot.listener,
    entry.rootProcess,
    entry.listenerProcess,
    listenerSnapshot.processes,
  ));
  if (listenerVerified && listenerSnapshot?.listener && !entry.listenerProcess) entry.listenerProcess = listenerSnapshot.listener;
  return trustedGracefulStopPolicy(true, listenerVerified).runGracefulStop;
}

export async function stopTrustedManagedProcess(command: TrustedManagedCommand) {
  const current = runtime.processes.get(command.runtimeKey);
  if (!current) return { status: "error", message: "No DevHub-owned process is running for this service." } satisfies RepositoryActionResult;
  if (command.gracefulStop && await canRunTrustedGracefulStop(current)) {
    try {
      await runTrustedStopCommand(command);
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && await isPortListening(command.port)) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!await isPortListening(command.port)) {
        if (current.child.exitCode !== null) await finalizeExitedEntry(current, current.child.exitCode);
        if (!runtime.processes.has(command.runtimeKey)) {
          const stopped = {
            ...stoppedStatusForEntry(current, runtime.failures.get(command.runtimeKey) ?? null),
            message: "Managed shutdown verified by DevHub.",
            exitClassification: "managed-stop",
            exitCode: current.child.exitCode,
          } satisfies DevServerStatus;
          return { status: "stopped", message: "DevHub stopped its trusted local process.", devServer: stopped } satisfies RepositoryActionResult;
        }
      }
    } catch {
      // Ownership-verified lifecycle handling below performs the safe fallback.
    }
  }
  return stopManagedRuntime(command.runtimeKey, "DevHub stopped its trusted local process.");
}

async function stopManagedRuntime(key: string, stoppedMessage: string): Promise<RepositoryActionResult> {
  const entry = runtime.processes.get(key);
  if (!entry) {
    const stopped = runtime.lastStatus.get(key);
    if (stopped?.state === "stopped") {
      return { status: "stopped", message: "The DevHub-managed process is already stopped.", output: stopped.historicalFailure?.output ?? stopped.output, devServer: stopped };
    }
    return { status: "error", message: "No DevHub-owned process is running for this service." };
  }

  entry.stopping = true;
  if (process.platform === "win32") {
    const portListening = entry.port ? await isPortListening(entry.port) : false;
    const listenerSnapshot = portListening && entry.port ? await readWindowsListenerSnapshot(entry.port) : null;
    const processes = listenerSnapshot?.processes ?? await readWindowsProcessTableWithRetry();
    const root = entry.rootProcess ? processes?.get(entry.rootProcess.pid) : null;
    const rootVerified = sameWindowsProcess(entry.rootProcess, root);
    const survivingOwned = processes ? survivingWindowsProcesses(entry.ownedProcesses, processes) : [];
    const currentListener = listenerSnapshot?.listener ?? null;
    const listenerVerified = Boolean(processes && listenerBelongsToWindowsLaunch(
      currentListener,
      entry.rootProcess,
      entry.listenerProcess,
      processes,
    ));

    if (!processes || (portListening && !listenerVerified) || (!portListening && !rootVerified && survivingOwned.length === 0)) {
      entry.stopping = false;
      const policy = unverifiedWindowsOwnershipPolicy(portListening);
      if (portListening) {
        const uncertain = statusForEntry(entry, policy.state, policy.message);
        return { status: "error", message: uncertain.message, output: outputExcerpt(entry.output), devServer: uncertain };
      }
      const uncertain = statusForEntry(entry, policy.state, policy.message);
      return { status: "error", message: uncertain.message, output: uncertain.output, devServer: uncertain };
    }

    if (currentListener && !entry.listenerProcess) entry.listenerProcess = currentListener;
    const ownedProcesses = new Map<number, WindowsProcessEvidence>();
    if (rootVerified && entry.rootProcess) {
      for (const owned of collectWindowsProcessTree(entry.rootProcess.pid, processes)) ownedProcesses.set(owned.pid, owned);
    }
    for (const owned of survivingOwned) ownedProcesses.set(owned.pid, owned);
    if (currentListener) {
      for (const owned of collectWindowsProcessTree(currentListener.pid, processes)) ownedProcesses.set(owned.pid, owned);
    }

    const killTree = async (pid: number, force: boolean) => {
      try {
        await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true });
      } catch {
        // Verification below decides whether the owned tree was actually stopped.
      }
    };
    if (currentListener) await killTree(currentListener.pid, false);
    if (rootVerified && entry.rootProcess && entry.rootProcess.pid !== currentListener?.pid) {
      await killTree(entry.rootProcess.pid, false);
    }
    if (!rootVerified && !currentListener) {
      const aliveIds = new Set(survivingOwned.map((owned) => owned.pid));
      for (const owned of survivingOwned.filter((candidate) => !aliveIds.has(candidate.parentPid))) await killTree(owned.pid, false);
    }

    const gracefulDeadline = Date.now() + Math.min(1_500, STOP_WAIT_MS);
    while (Date.now() < gracefulDeadline && entry.port && await isPortListening(entry.port)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (entry.port && await isPortListening(entry.port)) {
      if (currentListener) await killTree(currentListener.pid, true);
      if (rootVerified && entry.rootProcess && entry.rootProcess.pid !== currentListener?.pid) await killTree(entry.rootProcess.pid, true);
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
  const stopped = {
    ...stoppedStatusForEntry(entry, runtime.failures.get(key) ?? null),
    message: "Managed shutdown verified by DevHub.",
    exitClassification: "managed-stop",
    exitCode: entry.child.exitCode,
  } satisfies DevServerStatus;
  runtime.lastStatus.set(key, stopped);
  return {
    status: "stopped",
    message: stoppedMessage,
    output: stopped.output,
    devServer: stopped,
  };
}

export async function stopDevServer(repository: Repository, service: ProjectService, options: ServiceRuntimeOptions = {}): Promise<RepositoryActionResult> {
  const message = service.kind === "spring-boot" ? "DevHub stopped its backend." : "DevHub stopped its application process.";
  return stopManagedRuntime(serviceRuntimeKey(repository.id, service.id, options.runtimeScope), message);
}
