"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import type { RefreshWorkspaceState } from "./action-state";
import { refreshWorkspaceAction } from "./actions";

export function RefreshWorkspaceButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<RefreshWorkspaceState>({ status: "idle", message: "" });

  function refresh() {
    startTransition(async () => {
      const result = await refreshWorkspaceAction();
      setState(result);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="refresh-control">
      <button type="button" disabled={pending} onClick={refresh}>
        <RefreshCw className={pending ? "spin" : undefined} aria-hidden="true" size={13} />
        {pending ? "Scanning…" : "Refresh"}
      </button>
      {state.message && <span className={state.status === "error" ? "refresh-error" : ""} role="status">{state.message}</span>}
    </div>
  );
}
