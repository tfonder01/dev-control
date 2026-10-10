export function trackedRuntimePort(currentPort: number | null, output: string) {
  // DevHub explicitly assigns every managed runtime a port. Later application
  // output can mention other localhost services and must not retarget ownership.
  if (currentPort) return currentPort;

  const matches = [...output.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):([0-9]{1,5})/gi)];
  const detected = Number(matches.at(-1)?.[1]);
  return detected >= 1 && detected <= 65_535 ? detected : null;
}
