import assert from "node:assert/strict";
import test from "node:test";

import { trackedRuntimePort } from "../lib/projects/process-output.ts";

test("later localhost log output cannot retarget an assigned runtime port", () => {
  assert.equal(
    trackedRuntimePort(3001, "Allowed frontend origin: http://localhost:3000"),
    3001,
  );
});

test("can detect a local URL only when no runtime port has been assigned", () => {
  assert.equal(trackedRuntimePort(null, "Ready at http://127.0.0.1:4317"), 4317);
  assert.equal(trackedRuntimePort(null, "No local URL"), null);
  assert.equal(trackedRuntimePort(null, "http://localhost:99999"), null);
});
