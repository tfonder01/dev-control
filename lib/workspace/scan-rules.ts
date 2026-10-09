export const MAX_SCAN_DEPTH = 6;
export const MAX_DIRECTORIES = 20_000;

export const SKIPPED_DIRECTORIES = new Set([
  ".next", ".idea", ".vscode", ".gradle", ".mvn", ".turbo", ".cache",
  "node_modules", "target", "build", "dist", "coverage", "out", "vendor",
  "venv", ".venv", "__pycache__",
]);
