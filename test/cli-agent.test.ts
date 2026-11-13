import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CliAgentError, cliAgentNode, parseResetTime } from "../src/cli-agent.js";

test("closes the CLI's stdin so agents that read piped stdin don't hang", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const fake = path.join(dir, "fake-cli");
    await writeFile(
      fake,
      `#!/usr/bin/env node\nlet n = 0;\nprocess.stdin.on("data", (c) => (n += c.length));\nprocess.stdin.on("end", () => console.log("stdin bytes: " + n));\n`,
    );
    await chmod(fake, 0o755);

    const node = cliAgentNode<{ out?: string }>({
      agent: "claude",
      command: fake,
      timeoutMs: 5_000,
      input: () => "hi",
      output: (text) => ({ out: text }),
    });
    const result = await node({}, { node: "fake", step: 1, emit: () => {} });
    assert.deepEqual(result, { out: "stdin bytes: 0" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("passes --trust to Cursor only when trustWorkspace is set", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const fake = path.join(dir, "fake-cli");
    await writeFile(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(fake, 0o755);

    const argsFor = async (trustWorkspace: boolean) => {
      const node = cliAgentNode<{ out?: string }>({
        agent: "cursor",
        command: fake,
        trustWorkspace,
        timeoutMs: 5_000,
        input: () => "hi",
        output: (text) => ({ out: text }),
      });
      const result = await node({}, { node: "fake", step: 1, emit: () => {} });
      return JSON.parse(result?.out ?? "[]") as string[];
    };
    assert.ok((await argsFor(true)).includes("--trust"));
    assert.ok(!(await argsFor(false)).includes("--trust"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fakeCli(dir: string, body: string) {
  const file = path.join(dir, "fake-cli");
  await writeFile(file, `#!/usr/bin/env node\nconst fs = require("fs");\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

const ctx = (logs: string[] = []) => ({ node: "n", step: 1, emit: (e: { type: string; message?: string }) => void (e.type === "log" && logs.push(e.message!)) });

test("retries a failing CLI and succeeds on a later attempt", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const counter = path.join(dir, "count");
    const fake = await fakeCli(
      dir,
      `const n = fs.existsSync(${JSON.stringify(counter)}) ? 1 : 0; fs.writeFileSync(${JSON.stringify(counter)}, "x");
       if (n === 0) { console.error("config locked"); process.exit(1); } console.log("ok");`,
    );
    const logs: string[] = [];
    const node = cliAgentNode<{ out?: string }>({
      agent: "claude", command: fake, retryDelayMs: 10, input: () => "hi", output: (out) => ({ out }),
    });
    assert.deepEqual(await node({}, ctx(logs)), { out: "ok" });
    assert.ok(logs.some((l) => /failed \(attempt 1\/3\).*config locked/.test(l)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("after the last retry, onError records the failure instead of stopping the graph", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const fake = await fakeCli(dir, `console.log("internal server error"); process.exit(3);`);
    const spec = {
      agent: "cursor" as const, command: fake, retries: 1, retryDelayMs: 10,
      input: () => "SECRET PROMPT TEXT", output: (out: string) => ({ out }),
    };

    const recovered = cliAgentNode<{ out?: string }>({ ...spec, onError: (e) => ({ out: `failed: ${e.message}` }) });
    const result = await recovered({}, ctx());
    assert.match(result!.out!, /exited with code 3: internal server error/);
    assert.doesNotMatch(result!.out!, /SECRET PROMPT TEXT/);

    const strict = cliAgentNode<{ out?: string }>(spec);
    await assert.rejects(Promise.resolve(strict({}, ctx())), CliAgentError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing CLI is not retried", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const logs: string[] = [];
  const node = cliAgentNode<{ out?: string }>({
    agent: "codex", command: "/nonexistent/graphwork-cli", retryDelayMs: 10_000, input: () => "hi", output: (out) => ({ out }),
  });
  await assert.rejects(Promise.resolve(node({}, ctx(logs))), /not found/);
  assert.equal(logs.length, 0);
});

test("parallel Cursor calls run one at a time", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const fake = await fakeCli(dir, `const t = Date.now(); setTimeout(() => console.log(t + "-" + Date.now()), 150);`);
    const node = cliAgentNode<{ out?: string }>({ agent: "cursor", command: fake, input: () => "hi", output: (out) => ({ out }) });
    const [a, b] = await Promise.all([node({}, ctx()), node({}, ctx())]);
    const [first, second] = [a!.out!, b!.out!].map((r) => r.split("-").map(Number)).sort((x, y) => x[0]! - y[0]!);
    assert.ok(second![0]! >= first![1]!, `second call started at ${second![0]} before the first ended at ${first![1]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude gets edit and command permissions only when asked", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const fake = await fakeCli(dir, `console.log(JSON.stringify(process.argv.slice(2)));`);
    const argsFor = async (canEdit: boolean, canRunCommands: boolean) => {
      const node = cliAgentNode<{ out?: string }>({
        agent: "claude", command: fake, canEdit, canRunCommands, input: () => "hi", output: (out) => ({ out }),
      });
      return JSON.parse((await node({}, ctx()))!.out!) as string[];
    };
    const readOnly = await argsFor(false, false);
    assert.ok(!readOnly.includes("acceptEdits") && !readOnly.includes("--allowedTools"));
    const builder = await argsFor(true, true);
    assert.ok(builder.includes("acceptEdits"));
    assert.deepEqual(builder.slice(builder.indexOf("--allowedTools"), builder.indexOf("--allowedTools") + 2), ["--allowedTools", "Bash"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude runs as a subagent, and sandboxed commands get sandbox settings", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const fake = await fakeCli(
      dir,
      `const a = process.argv.slice(2); const i = a.indexOf("--settings");
       console.log(JSON.stringify({ a, settings: i >= 0 ? JSON.parse(fs.readFileSync(a[i + 1], "utf8")) : null }));`,
    );
    const node = cliAgentNode<{ out?: string }>({
      agent: "claude", command: fake, subagent: "test-engineer", canEdit: true, sandboxCommands: true,
      input: () => "hi", output: (out) => ({ out }),
    });
    const { a, settings } = JSON.parse((await node({}, ctx()))!.out!);
    assert.deepEqual(a.slice(a.indexOf("--agent"), a.indexOf("--agent") + 2), ["--agent", "test-engineer"]);
    assert.ok(a.includes("--allowedTools"));
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.equal(settings.sandbox.network.allowLocalBinding, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses reset times from the formats the CLIs print", () => {
  const now = new Date(2026, 9, 30, 14, 0, 0);
  assert.equal(parseResetTime("Claude AI usage limit reached|1793330000", now)?.getTime(), 1793330000 * 1000);
  assert.equal(parseResetTime("limit reached, resets 3pm", now)?.getHours(), 15);
  const tomorrow = parseResetTime("5-hour limit reached ∙ resets at 9:30am", now)!;
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()], [31, 9, 30]);
  assert.equal(parseResetTime("rate limit exceeded, try again in 2h 15m", now)?.getTime(), now.getTime() + 8100_000);
  assert.equal(parseResetTime("quota reached until 2026-10-30T18:00:00Z", now)?.toISOString(), "2026-10-30T18:00:00.000Z");
  assert.equal(parseResetTime("usage limit reached", now), undefined);
});

test("a usage limit pauses the node and continues once it lifts, without using a retry", async () => {
  delete process.env.GRAPHWORK_MOCK;
  process.env.GRAPHWORK_LIMIT_POLL_MS = "50";
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const counter = path.join(dir, "count");
    const fake = await fakeCli(
      dir,
      `const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
       fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
       if (n === 0) { console.error("Error: usage limit reached"); process.exit(1); }
       if (n === 1) { console.log("You've hit your limit reached for this session."); process.exit(0); }
       console.log("real answer");`,
    );
    const logs: string[] = [];
    const node = cliAgentNode<{ out?: string }>({
      agent: "claude", command: fake, retries: 0, input: () => "hi", output: (out) => ({ out }),
    });
    assert.deepEqual(await node({}, ctx(logs)), { out: "real answer" });
    assert.equal(logs.filter((l) => /usage limit reached; paused until/.test(l)).length, 2);
  } finally {
    delete process.env.GRAPHWORK_LIMIT_POLL_MS;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reviewer's normal reply that mentions rate limiting is not taken for a limit", async () => {
  delete process.env.GRAPHWORK_MOCK;
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const fake = await fakeCli(dir, `console.log("High: the login API has no rate limit on attempts.");`);
    const node = cliAgentNode<{ out?: string }>({ agent: "claude", command: fake, input: () => "hi", output: (out) => ({ out }) });
    assert.match((await node({}, ctx()))!.out!, /no rate limit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
