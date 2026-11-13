import assert from "node:assert/strict";
import { test } from "node:test";
import { END, START, StateGraph, subgraphNode, type GraphEvent } from "../src/graph.js";

interface Child {
  n: number;
}
interface Parent {
  start: number;
  result?: number;
}

const doubler = new StateGraph<Child>()
  .addNode("double", (s) => ({ n: s.n * 2 }))
  .addNode("inc", (s) => ({ n: s.n + 1 }))
  .addEdge(START, "double")
  .addEdge("double", "inc")
  .addEdge("inc", END)
  .compile();

const parent = () =>
  new StateGraph<Parent>()
    .addNode("team", subgraphNode(doubler, { input: (p) => ({ n: p.start }), output: (c) => ({ result: c.n }) }))
    .addEdge(START, "team")
    .addEdge("team", END)
    .compile();

test("subgraph runs as one node and maps state across the boundary", async () => {
  const { state, steps } = await parent().run({ start: 5 });
  assert.equal(state.result, 11);
  assert.equal(steps, 1);
});

test("child events are forwarded with prefixed node names", async () => {
  const events: GraphEvent[] = [];
  await parent().run({ start: 1 }, { onEvent: (e) => events.push(e) });
  const ended = events.filter((e) => e.type === "node_end").map((e) => (e as { node: string }).node);
  assert.deepEqual(ended, ["team/double", "team/inc", "team"]);
  const childRoute = events.find((e) => e.type === "route" && e.from === "team/inc");
  assert.deepEqual(childRoute && "to" in childRoute ? childRoute.to : null, [END]);
});

test("subgraphs nest more than one level deep", async () => {
  const middle = new StateGraph<Child>()
    .addNode("inner", subgraphNode(doubler, { input: (s) => s, output: (c) => ({ n: c.n }) }))
    .addEdge(START, "inner")
    .addEdge("inner", END)
    .compile();
  const top = new StateGraph<Parent>()
    .addNode("outer", subgraphNode(middle, { input: (p) => ({ n: p.start }), output: (c) => ({ result: c.n }) }))
    .addEdge(START, "outer")
    .addEdge("outer", END)
    .compile();
  const nodes: string[] = [];
  const { state } = await top.run({ start: 2 }, { onEvent: (e) => e.type === "node_end" && nodes.push(e.node) });
  assert.equal(state.result, 5);
  assert.ok(nodes.includes("outer/inner/double"));
});

test("toMermaid draws subgraphs as nested boxes", () => {
  const m = parent().toMermaid();
  assert.match(m, /subgraph team \[team\]/);
  assert.match(m, /team__in --> team__double/);
  assert.match(m, /team__inc --> team__out/);
  assert.match(m, /START --> team/);
});
