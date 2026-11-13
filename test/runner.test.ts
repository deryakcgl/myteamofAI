import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectDir } from "../src/runner.js";

test("projectDir uses $GRAPHWORK_PROJECT and defaults outside the repo", () => {
  const saved = process.env.GRAPHWORK_PROJECT;
  try {
    delete process.env.GRAPHWORK_PROJECT;
    assert.equal(projectDir(), path.join(homedir(), "graphwork-projects", "default"));
    process.env.GRAPHWORK_PROJECT = "/tmp/some-project";
    assert.equal(projectDir(), "/tmp/some-project");
  } finally {
    if (saved === undefined) delete process.env.GRAPHWORK_PROJECT;
    else process.env.GRAPHWORK_PROJECT = saved;
  }
});

test("projectDir refuses folders inside graphwork, where agents would read its AGENTS.md", () => {
  const saved = process.env.GRAPHWORK_PROJECT;
  try {
    for (const inside of ["workspace", ".", "examples/x"]) {
      process.env.GRAPHWORK_PROJECT = path.resolve(inside);
      assert.throws(() => projectDir(), /inside graphwork/);
    }
  } finally {
    if (saved === undefined) delete process.env.GRAPHWORK_PROJECT;
    else process.env.GRAPHWORK_PROJECT = saved;
  }
});
