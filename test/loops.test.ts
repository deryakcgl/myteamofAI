import assert from "node:assert/strict";
import { test } from "node:test";
import { loopStart, retryNotes, validationLoop, type LoopState } from "../src/loops.js";

const run = (acceptOn: number, max: number) => {
  let works = 0;
  const loop = validationLoop({
    names: ["writer", "checker"],
    maxIterations: max,
    work: (s) => ({ draft: `draft ${++works}${s.feedback ? " (revised)" : ""}` }),
    check: (s: Readonly<LoopState>) => ({ valid: s.iteration + 1 >= acceptOn, feedback: "needs work" }),
  });
  return { loop, works: () => works };
};

test("retries with feedback until the checker accepts", async () => {
  const { loop, works } = run(2, 5);
  const { state } = await loop.run(loopStart("ctx"));
  assert.equal(works(), 2);
  assert.equal(state.iteration, 2);
  assert.equal(state.valid, true);
  assert.equal(state.draft, "draft 2 (revised)");
});

test("stops at maxIterations even if never accepted", async () => {
  const { loop, works } = run(99, 3);
  const { state } = await loop.run(loopStart("ctx"));
  assert.equal(works(), 3);
  assert.equal(state.valid, false);
});

test("the loop's model has one bounded cycle with an exit", () => {
  const { loop } = run(1, 3);
  assert.deepEqual(loop.analyze().cycles, [{ nodes: ["writer", "checker"], exits: [{ from: "checker", to: "__end__" }], bound: 3 }]);
});

test("retryNotes shows feedback and the previous draft only after a rejection", () => {
  assert.equal(retryNotes(loopStart("ctx")), "");
  const notes = retryNotes({ ...loopStart("ctx"), draft: "v1", feedback: "missing X", iteration: 1 });
  assert.match(notes, /rejected by the validator\nmissing X/);
  assert.match(notes, /previous attempt\nv1/);
});
