import assert from "node:assert/strict";
import { test } from "node:test";
import { END, GraphError, START, StateGraph, reducers } from "../src/graph.js";

interface S {
  log: string[];
  count: number;
  value?: string;
}
const init = (): S => ({ log: [], count: 0 });

test("runs a linear graph and merges updates", async () => {
  const g = new StateGraph<S>({ reducers: { log: reducers.append() } })
    .addNode("a", () => ({ log: ["a"], value: "x" }))
    .addNode("b", (s) => ({ log: ["b"], value: s.value + "y" }))
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", END)
    .compile();
  const { state, path } = await g.run(init());
  assert.deepEqual(state.log, ["a", "b"]);
  assert.equal(state.value, "xy");
  assert.deepEqual(path, [["a"], ["b"]]);
});

test("conditional edges loop until the router returns END", async () => {
  const g = new StateGraph<S>()
    .addNode("inc", (s) => ({ count: s.count + 1 }))
    .addEdge(START, "inc")
    .addConditionalEdges("inc", (s) => (s.count < 3 ? "inc" : END), ["inc", END])
    .compile();
  const { state, steps } = await g.run(init());
  assert.equal(state.count, 3);
  assert.equal(steps, 3);
});

test("fan-out runs in parallel and the join node runs once", async () => {
  let joins = 0;
  const g = new StateGraph<S>({ reducers: { log: reducers.append() } })
    .addNode("split", () => ({}))
    .addNode("left", async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { log: ["left"] };
    })
    .addNode("right", () => ({ log: ["right"] }))
    .addNode("join", (s) => {
      joins++;
      return { value: [...s.log].sort().join("+") };
    })
    .addEdge(START, "split")
    .addEdge("split", ["left", "right"])
    .addEdge("left", "join")
    .addEdge("right", "join")
    .addEdge("join", END)
    .compile();
  const { state, path } = await g.run(init());
  assert.equal(joins, 1);
  assert.equal(state.value, "left+right");
  assert.deepEqual(path[1], ["left", "right"]);
});

test("parallel writes to a key without a reducer fail loudly", async () => {
  const g = new StateGraph<S>()
    .addNode("p", () => ({ value: "p" }))
    .addNode("q", () => ({ value: "q" }))
    .addEdge(START, ["p", "q"])
    .addEdge("p", END)
    .addEdge("q", END)
    .compile();
  await assert.rejects(g.run(init()), /both wrote "value"/);
});

test("router may not return an undeclared target", async () => {
  const g = new StateGraph<S>()
    .addNode("a", () => ({}))
    .addNode("b", () => ({}))
    .addEdge(START, "a")
    .addConditionalEdges("a", () => "b", [END])
    .addEdge("b", END)
    .compile();
  await assert.rejects(g.run(init()), /returned "b"/);
});

test("maxSteps stops a loop whose router never lets go", async () => {
  const g = new StateGraph<S>()
    .addNode("spin", () => ({}))
    .addEdge(START, "spin")
    .addConditionalEdges("spin", () => "spin", ["spin", END])
    .compile();
  await assert.rejects(g.run(init(), { maxSteps: 5 }), /maxSteps=5/);
});

test("a loop with no exit edge is rejected at compile time", () => {
  assert.throws(
    () =>
      new StateGraph<S>()
        .addNode("a", () => ({}))
        .addNode("b", () => ({}))
        .addEdge(START, "a")
        .addEdge("a", "b")
        .addEdge("b", "a")
        .compile(),
    /Loop \{a, b\} has no exit/,
  );
});

test("analyze models the graph as V, E and its loops with exits and bounds", () => {
  const g = new StateGraph<S>()
    .addNode("write", () => ({}))
    .addNode("check", () => ({}))
    .addNode("ship", () => ({}))
    .addEdge(START, "write")
    .addEdge("write", "check")
    .addConditionalEdges("check", () => "ship", ["write", "ship"], { bound: 3 })
    .addEdge("ship", END)
    .compile();
  const m = g.analyze();
  assert.deepEqual(m.vertices, [START, "write", "check", "ship", END]);
  assert.equal(m.edges.length, 5);
  assert.equal(m.acyclic, false);
  assert.deepEqual(m.cycles, [{ nodes: ["write", "check"], exits: [{ from: "check", to: "ship" }], bound: 3 }]);
});

test("compile validates structure", () => {
  assert.throws(() => new StateGraph<S>().addNode("a", () => ({})).compile(), GraphError);
  assert.throws(
    () => new StateGraph<S>().addNode("a", () => ({})).addEdge(START, "a").compile(),
    /no outgoing edge/,
  );
  assert.throws(
    () => new StateGraph<S>().addNode("a", () => ({})).addEdge(START, "a").addEdge("a", "ghost").compile(),
    /unknown node "ghost"/,
  );
});

test("toMermaid draws static and routed edges", () => {
  const g = new StateGraph<S>()
    .addNode("a", () => ({}))
    .addEdge(START, "a")
    .addConditionalEdges("a", () => END, ["a", END])
    .compile();
  const m = g.toMermaid();
  assert.match(m, /START --> a/);
  assert.match(m, /a -.-> END/);
});
