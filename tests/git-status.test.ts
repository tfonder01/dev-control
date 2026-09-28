import assert from "node:assert/strict";
import test from "node:test";

import { parseGitStatus } from "../lib/workspace/git-status.ts";

test("preserves porcelain filenames for common working-tree states", () => {
  const porcelain = [
    " M README.md",
    "A  added file.txt",
    " D deleted document.md",
    "?? untracked notes.txt",
    "R  renamed destination.md",
    "renamed source.md",
    "?? path with spaces/new file.txt",
    "",
  ].join("\0");

  assert.deepEqual(parseGitStatus(porcelain), [
    "README.md",
    "added file.txt",
    "deleted document.md",
    "untracked notes.txt",
    "renamed destination.md",
    "path with spaces/new file.txt",
  ]);
});

test("does not trim significant whitespace from a filename", () => {
  assert.deepEqual(parseGitStatus("??  leading-space.txt\0"), [" leading-space.txt"]);
});
