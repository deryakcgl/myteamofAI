import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AwaitingHumanError, formatTodo, humanGate, parseTodo } from "../src/human.js";

test("a TODO list round-trips: unticked items, ticks, and answers", () => {
  const md = formatTodo("r2", "To do", ["Decide the servo sign", "Install PlatformIO"]);
  const fresh = parseTodo(md);
  assert.equal(fresh.id, "r2");
  assert.deepEqual(fresh.items.map((i) => [i.text, i.done]), [["Decide the servo sign", false], ["Install PlatformIO", false]]);

  const answered = md
    .replace("- [ ] Decide the servo sign\n  Answer: ", "- [x] Decide the servo sign\n  Answer: positive, checked on the bench")
    .replace("- [ ] Install", "- [X] Install");
  const { items } = parseTodo(answered);
  assert.ok(items.every((i) => i.done));
  assert.equal(items[0]!.notes, "positive, checked on the bench");
  assert.equal(items[1]!.notes, "");
});

test("the gate stops until every item is ticked, then passes the answers on", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "graphwork-test-"));
  try {
    const file = path.join(dir, "TODO.md");
    const gate = humanGate<{ round: number; answers?: string }>({
      file,
      id: (s) => `round-${s.round}`,
      title: () => "To do",
      items: () => ["Pick a colour"],
      onAnswers: (items) => ({ answers: items[0]!.notes }),
    });
    const s = { round: 3 };
    const ctx = { node: "human", step: 1, emit: () => {} };

    assert.throws(() => gate(s, ctx), AwaitingHumanError);
    assert.ok(existsSync(file));
    assert.throws(() => gate(s, ctx), /1 of 1 item\(s\) open/);

    writeFileSync(file, readFileSync(file, "utf8").replace("- [ ] Pick a colour\n  Answer: ", "- [x] Pick a colour\n  Answer: green"));
    assert.deepEqual(gate(s, ctx), { answers: "green" });
    assert.ok(!existsSync(file));
    assert.ok(existsSync(path.join(dir, "todo", "round-3.md")));

    assert.throws(() => gate({ round: 4 }, ctx), AwaitingHumanError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
