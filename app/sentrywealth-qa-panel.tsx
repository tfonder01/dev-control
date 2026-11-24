"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { cancelSentryWealthQa, getSentryWealthQa, openSentryWealthQaReport, startSentryWealthQa } from "./sentrywealth-qa-actions";
import type { QaReport, QaSuite } from "@/lib/projects/sentrywealth-qa";

const suites: Record<QaSuite, string> = { FullStack: "Full-stack QA", Visual: "Visual QA", All: "Complete QA" };
const reports: Record<QaReport, string> = { fullStack: "Full-stack report", visual: "Visual report" };
const states = { running: "Running", passed: "Passed", failed: "Failed", cancelled: "Cancelled" };
type QaPanelState = NonNullable<Awaited<ReturnType<typeof getSentryWealthQa>>>;

export function SentryWealthQaPanel({ repositoryId, initial }: { repositoryId: string; initial: QaPanelState }) {
  const [{ run, reports: availableReports }, setStatus] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requestedRevision = revision.current;
      try {
        if (document.visibilityState === "visible" && requestedRevision % 2 === 0) {
          const status = await getSentryWealthQa(repositoryId);
          if (!disposed && status && requestedRevision === revision.current) setStatus(status);
        }
      } catch {
        // Retry on the next tick if the local server is temporarily unavailable.
      } finally {
        if (!disposed) timer = setTimeout(poll, 2_000);
      }
    }
    timer = setTimeout(poll, 2_000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [repositoryId]);

  async function act(action: () => Promise<{ error?: string; run?: QaPanelState["run"] }>) {
    if (revision.current % 2 !== 0) return;
    revision.current += 1;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result.error) setError(result.error);
      if (result.run !== undefined) setStatus((status) => ({ ...status, run: result.run ?? null }));
    } catch {
      setError("DevHub could not complete the QA action.");
    } finally {
      revision.current += 1;
      setPending(false);
    }
  }

  return (
    <section className="project-actions" aria-labelledby="sentrywealth-qa-title">
      <div className="project-actions-heading"><h2 id="sentrywealth-qa-title">Quality assurance</h2></div>
      <div className="action-group quick-action-group">
        <div className="action-buttons">
          {(Object.keys(suites) as QaSuite[]).map((suite) => (
            <button key={suite} type="button" className="project-action-button" disabled={pending || run?.state === "running"}
              onClick={() => void act(() => startSentryWealthQa(repositoryId, suite))}>Run {suites[suite]}</button>
          ))}
          {run?.state === "running" && (
            <button type="button" className="project-action-button" disabled={pending || run.cancelling}
              onClick={() => void act(() => cancelSentryWealthQa(repositoryId, run.id))}>Cancel QA</button>
          )}
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {run && (
          <div className={`action-result ${run.state === "failed" ? "action-result-error" : run.state === "cancelled" ? "" : "action-result-success"}`}>
            <div>
              <strong role="status">{suites[run.suite]} · {run.cancelling ? "Cancelling" : states[run.state]}</strong>
              <span>{(run.elapsedMs / 1000).toFixed(1)}s</span>
            </div>
            {run.output && <details><summary>Recent execution log</summary><pre>{run.output}</pre></details>}
          </div>
        )}
        {availableReports.length > 0 && (
          <div className="action-buttons quick-action-group">
            {availableReports.map((report) => (
              <button type="button" className="project-action-button" key={report} disabled={pending}
                onClick={() => void act(() => openSentryWealthQaReport(repositoryId, report))}>
                Open {reports[report]} <ExternalLink aria-hidden="true" size={13} />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
