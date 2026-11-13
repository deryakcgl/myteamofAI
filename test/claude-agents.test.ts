import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeClaudeAgents } from "../src/claude-agents.js";

test("writes Claude Code subagent files with frontmatter and role-limited tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    await writeClaudeAgents(dir, [
      { name: "reviewer", description: "Reviews code.", tools: "read", instructions: "Review it." },
      { name: "tester", description: "Runs tests.", tools: "test", instructions: "Test it.", model: "sonnet" },
    ]);
    const reviewer = await readFile(path.join(dir, ".claude/agents/reviewer.md"), "utf8");
    assert.match(reviewer, /^---\nname: reviewer\ndescription: Reviews code\.\ntools: Read, Grep, Glob\n---\n\nReview it\.\n$/);
    const tester = await readFile(path.join(dir, ".claude/agents/tester.md"), "utf8");
    assert.match(tester, /tools: .*Bash\nmodel: sonnet\n/);
    assert.doesNotMatch(reviewer, /model:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
