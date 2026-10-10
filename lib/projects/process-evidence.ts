export type WindowsProcessEvidence = {
  pid: number;
  parentPid: number;
  creationTime: string;
  executablePath: string | null;
  commandLine: string | null;
};

export function sameWindowsProcess(
  left: WindowsProcessEvidence | undefined | null,
  right: WindowsProcessEvidence | undefined | null,
) {
  return Boolean(left && right && left.pid === right.pid && left.creationTime === right.creationTime);
}

export function isWindowsProcessDescendantOf(
  pid: number,
  ancestorPid: number,
  processes: Map<number, WindowsProcessEvidence>,
) {
  const visited = new Set<number>();
  let current = processes.get(pid);
  while (current && !visited.has(current.pid)) {
    if (current.pid === ancestorPid) return true;
    visited.add(current.pid);
    current = processes.get(current.parentPid);
  }
  return false;
}

export function collectWindowsProcessTree(
  rootPid: number,
  processes: Map<number, WindowsProcessEvidence>,
) {
  return [...processes.values()].filter((candidate) => (
    isWindowsProcessDescendantOf(candidate.pid, rootPid, processes)
  ));
}

export function listenerBelongsToWindowsLaunch(
  listener: WindowsProcessEvidence | undefined | null,
  rootProcess: WindowsProcessEvidence | undefined | null,
  capturedListener: WindowsProcessEvidence | undefined | null,
  processes: Map<number, WindowsProcessEvidence>,
) {
  if (!listener) return false;
  if (sameWindowsProcess(capturedListener, listener)) return true;

  const currentRoot = rootProcess ? processes.get(rootProcess.pid) : null;
  if (!rootProcess || !sameWindowsProcess(rootProcess, currentRoot)) return false;
  return isWindowsProcessDescendantOf(listener.pid, rootProcess.pid, processes);
}

function normalizeWindowsValue(value: string) {
  return value.replaceAll("/", "\\").toLowerCase();
}

function containsServicePath(value: string | null, servicePath: string) {
  if (!value) return false;
  const haystack = normalizeWindowsValue(value);
  const needle = normalizeWindowsValue(servicePath).replace(/\\+$/, "");
  if (!needle) return false;

  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    const before = haystack[offset - 1];
    const after = haystack[offset + needle.length];
    const hasStartBoundary = before === undefined || /[\s"'=;,]/.test(before);
    const hasEndBoundary = after === undefined || after === "\\" || /[\s"',;]/.test(after);
    if (hasStartBoundary && hasEndBoundary) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

export function listenerMatchesServicePath(
  listenerPid: number,
  servicePath: string,
  processes: Map<number, WindowsProcessEvidence>,
) {
  const visited = new Set<number>();
  let current = processes.get(listenerPid);
  while (current && !visited.has(current.pid)) {
    if (containsServicePath(current.executablePath, servicePath) || containsServicePath(current.commandLine, servicePath)) {
      return true;
    }
    visited.add(current.pid);
    current = processes.get(current.parentPid);
  }
  return false;
}

export function classifyUnmanagedListener(
  listenerPid: number | null,
  servicePath: string,
  processes: Map<number, WindowsProcessEvidence> | null,
): "external" | "port-in-use" {
  return listenerPid && processes && listenerMatchesServicePath(listenerPid, servicePath, processes)
    ? "external"
    : "port-in-use";
}
