export function parseGitStatus(output: string) {
  const entries = output.split("\0");
  const changedFiles: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;

    const status = entry.slice(0, 2);
    changedFiles.push(entry.slice(3));

    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }

  return changedFiles;
}
