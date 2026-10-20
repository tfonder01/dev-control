export function classifyManagedProcessExit(
  stopRequested: boolean,
  exitCode: number | null,
  processName: string,
  classifiedFailure: string | null = null,
) {
  if (stopRequested) {
    return {
      state: "stopped" as const,
      message: "Managed shutdown verified by DevHub.",
      exitClassification: "managed-stop" as const,
      exitCode,
    };
  }
  return {
    state: "failed" as const,
    message: classifiedFailure ?? `${processName} exited unexpectedly (code ${exitCode ?? "unknown"}).`,
    exitClassification: "unexpected-exit" as const,
    exitCode,
  };
}

export function managedStartupSignal(wrapperExited: boolean, portListening: boolean) {
  if (wrapperExited) return "exited" as const;
  if (portListening) return "ready" as const;
  return "pending" as const;
}
