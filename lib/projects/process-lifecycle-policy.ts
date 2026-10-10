export function unverifiedWindowsOwnershipPolicy(portListening: boolean) {
  return {
    retainManagedProcess: true,
    state: "starting" as const,
    message: portListening
      ? "DevHub still tracks this launch, but could not verify ownership of the current listener. Nothing was stopped; retry after the process settles."
      : "DevHub could not verify its process identity, so it was not stopped.",
  };
}
