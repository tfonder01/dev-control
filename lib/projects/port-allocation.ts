export async function findAvailablePort(
  preferredPort: number,
  reservedPorts: ReadonlySet<number>,
  isListening: (port: number) => Promise<boolean>,
  rangeSize = 20,
) {
  for (let offset = 0; offset < rangeSize; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65_535) break;
    if (!reservedPorts.has(port) && !await isListening(port)) return port;
  }
  return null;
}
