import "server-only";

import { performance } from "node:perf_hooks";

import { scanWorkspace } from "./scanner";
import type { Repository, WorkspaceScanResult } from "./types";

export type WorkspaceSnapshot = WorkspaceScanResult & {
  scanDurationMs: number;
};

const SNAPSHOT_TTL_MS = 60_000;

let currentSnapshot: WorkspaceSnapshot | null = null;
let scanInFlight: Promise<WorkspaceSnapshot> | null = null;

async function performWorkspaceScan() {
  const startedAt = performance.now();
  const result = await scanWorkspace();
  return { ...result, scanDurationMs: Math.round(performance.now() - startedAt) };
}

function startWorkspaceScan() {
  if (!scanInFlight) {
    scanInFlight = performWorkspaceScan()
      .then((snapshot) => {
        currentSnapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        scanInFlight = null;
      });
  }

  return scanInFlight;
}

export async function getWorkspaceSnapshot() {
  if (!currentSnapshot) return startWorkspaceScan();

  const age = Date.now() - Date.parse(currentSnapshot.scannedAt);
  if (age >= SNAPSHOT_TTL_MS) void startWorkspaceScan().catch(() => undefined);
  return currentSnapshot;
}

export async function refreshWorkspaceSnapshot() {
  return startWorkspaceScan();
}

export async function getRepositoryFromSnapshot(id: string): Promise<Repository | null> {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return null;
  const snapshot = await getWorkspaceSnapshot();
  return snapshot.repositories.find((repository) => repository.id === id) ?? null;
}
