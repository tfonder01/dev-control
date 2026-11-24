import { performance } from "node:perf_hooks";

import { spawnProjectCommand } from "./command-process.ts";
import { cleanProcessOutput, MAX_PROCESS_OUTPUT_CHARS } from "./process-output.ts";
import { createBoundedRuntimeEnvironment } from "./runtime-environment.ts";

export const SENTRYWEALTH_REPOSITORY_ID = "mbl4t3RoIqL2ePxO";
export const qaSuites = ["FullStack", "Visual", "All"] as const;
export type QaSuite = (typeof qaSuites)[number];
export type QaRun = {
  id: number;
  suite: QaSuite;
  state: "running" | "passed" | "failed" | "cancelled";
  cancelling: boolean;
  elapsedMs: number;
  output: string;
};

export const qaReports = {
  fullStack: "qa/full-stack",
  visual: "qa/visual",
} as const;
export type QaReport = keyof typeof qaReports;

export function qaCommand(executable: string, cwd: string, wrapper: string, suite: QaSuite) {
  if (!qaSuites.includes(suite)) throw new Error("Unknown QA suite.");
  return {
    cwd,
    executable,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper, "-Suite", suite],
  };
}

export class SentryWealthQa {
  private current: QaRun | null = null;
  private child: ReturnType<typeof spawnProjectCommand> | null = null;
  private startedAt = 0;
  private lastId = 0;

  status(): QaRun | null {
    if (!this.current) return null;
    const elapsedMs = this.current.state === "running" ? performance.now() - this.startedAt : this.current.elapsedMs;
    return { ...this.current, elapsedMs: Math.round(elapsedMs) };
  }

  async start(suite: QaSuite, prepare: () => Promise<ReturnType<typeof qaCommand>>, spawn = spawnProjectCommand) {
    if (!qaSuites.includes(suite)) throw new Error("Unknown QA suite.");
    if (this.current?.state === "running") throw new Error("A SentryWealth QA run is already active.");
    const run: QaRun = {
      id: ++this.lastId, suite, state: "running", cancelling: false, elapsedMs: 0, output: "",
    };
    this.current = run;
    this.startedAt = performance.now();
    const finish = (state: QaRun["state"]) => {
      run.elapsedMs = performance.now() - this.startedAt;
      run.state = state;
      run.cancelling = false;
      this.child = null;
    };
    const append = (chunk: string) => {
      run.output = cleanProcessOutput(run.output + chunk).slice(-MAX_PROCESS_OUTPUT_CHARS);
    };
    try {
      const command = await prepare();
      if (run.cancelling) {
        finish("cancelled");
        return;
      }
      const child = spawn(command, createBoundedRuntimeEnvironment(process.env, {
        CI: "1", NO_COLOR: "1", FORCE_COLOR: "0",
      }), "pipe");
      this.child = child;
      child.stdout?.setEncoding("utf8").on("data", append);
      child.stderr?.setEncoding("utf8").on("data", append);
      child.stdin?.on("error", () => {
        if (run.cancelling) append("\nCould not send cancellation to the QA runner.\n");
        run.cancelling = false;
      });
      child.once("error", () => append("\nPowerShell could not launch the QA runner.\n"));
      child.once("close", (code) => {
        const state = code === 0 ? "passed" : code === 130 && run.cancelling ? "cancelled" : "failed";
        if (state === "failed" && code !== null) append(`\nQA exited with code ${code}.\n`);
        finish(state);
      });
    } catch (error) {
      append(error instanceof Error ? error.message : "The QA command could not be prepared.");
      finish(run.cancelling ? "cancelled" : "failed");
    }
  }

  cancel(id: number) {
    const run = this.current;
    if (!run || run.id !== id || run.state !== "running" || run.cancelling) return;
    run.cancelling = true;
    this.child?.stdin?.end("cancel\n");
  }
}
