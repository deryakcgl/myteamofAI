import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileCheckpointStore } from "../src/checkpoint.js";
import { END, START, StateGraph, subgraphNode } from "../src/graph.js";

interface S {
  log: string[];
}

function graph(runs: Record<string, number>, failB: { on: boolean }) {
  const node = (name: string) => (s: S) => {
    runs[name] = (runs[name] ?? 0) + 1;
    if (name === "b" && failB.on) throw new Error("limit reached");
    return { log: [...s.log, name] };
  };
  return new StateGraph<S>()
    .addNode("a", node("a"))
    .addNode("b", node("b"))
    .addNode("c", node("c"))
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", "c")
    .addEdge("c", END)
    .compile();
}

test("an interrupted run resumes at the failed step without redoing finished ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const file = path.join(dir, "checkpoint.json");
    const runs: Record<string, number> = {};
    const failB = { on: true };
    const g = graph(runs, failB);

    await assert.rejects(g.run({ log: [] }, { checkpoint: { store: new FileCheckpointStore(file), key: "root" } }));
    assert.ok(existsSync(file));

    failB.on = false;
    const { state } = await g.run({ log: ["ignored"] }, { checkpoint: { store: new FileCheckpointStore(file), key: "root" } });
    assert.deepEqual(state.log, ["a", "b", "c"]);
    assert.deepEqual(runs, { a: 1, b: 2, c: 1 });
    assert.ok(!existsSync(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a resume continues inside a subgraph", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const file = path.join(dir, "checkpoint.json");
    const runs: Record<string, number> = {};
    const failB = { on: true };
    const parent = new StateGraph<{ out: string[]; before: number }>()
      .addNode("before", (s) => ({ before: s.before + 1 }))
      .addNode("team", subgraphNode(graph(runs, failB), { input: () => ({ log: [] }), output: (c) => ({ out: c.log }) }))
      .addEdge(START, "before")
      .addEdge("before", "team")
      .addEdge("team", END)
      .compile();
    const opts = () => ({ checkpoint: { store: new FileCheckpointStore(file), key: "root" } });

    await assert.rejects(parent.run({ out: [], before: 0 }, opts()));
    failB.on = false;
    const { state } = await parent.run({ out: [], before: 0 }, opts());
    assert.deepEqual(state, { out: ["a", "b", "c"], before: 1 });
    assert.equal(runs.a, 1);
    assert.ok(!existsSync(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
