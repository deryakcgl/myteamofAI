import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NodeFn } from "./graph.js";

export interface TodoItem {
  text: string;
  done: boolean;
  notes: string;
}

export class AwaitingHumanError extends Error {
  constructor(
    readonly file: string,
    readonly items: TodoItem[],
  ) {
    const open = items.filter((i) => !i.done).length;
    super(`Waiting for you: ${open} of ${items.length} item(s) open in ${file}. Tick them, then resume.`);
  }
}

const ID = (id: string) => `<!-- graphwork-todo: ${id} -->`;

export function formatTodo(id: string, title: string, items: string[]): string {
  return [
    ID(id),
    `# ${title}`,
    "",
    "The team can't go further without you. For each item: do it or decide it, write any answer",
    "on the indented line under it, and tick it (`- [x]`). When every item is ticked, press",
    "**Continue** in the app, or run the same command with `--resume`.",
    "",
    ...items.flatMap((text) => [`- [ ] ${text}`, "  Answer: ", ""]),
  ].join("\n");
}

export function parseTodo(markdown: string): { id?: string; items: TodoItem[] } {
  const id = markdown.match(/<!-- graphwork-todo: (.+?) -->/)?.[1];
  const items: TodoItem[] = [];
  for (const line of markdown.split("\n")) {
    const item = line.match(/^\s*[-*] \[( |x|X)\]\s+(.*)$/);
    if (item) {
      items.push({ text: item[2]!.trim(), done: item[1] !== " ", notes: "" });
    } else if (items.length && /^\s+\S/.test(line)) {
      const note = line.trim().replace(/^Answer:\s*/i, "");
      const last = items[items.length - 1]!;
      if (note) last.notes = last.notes ? `${last.notes}\n${note}` : note;
    }
  }
  return { id, items };
}

export function answersText(items: TodoItem[]): string {
  return items.map((i) => `- ${i.text}\n  Answer: ${i.notes || "(done, no comment)"}`).join("\n");
}

export function humanGate<S>(opts: {
  file: string;
  id: (s: Readonly<S>) => string;
  title: (s: Readonly<S>) => string;
  items: (s: Readonly<S>) => string[];
  onAnswers: (items: TodoItem[], s: Readonly<S>) => Partial<S>;
}): NodeFn<S> {
  return (s) => {
    const id = opts.id(s);
    const existing = existsSync(opts.file) ? parseTodo(readFileSync(opts.file, "utf8")) : undefined;

    if (existing?.id !== id) {
      mkdirSync(path.dirname(opts.file), { recursive: true });
      const items = opts.items(s);
      writeFileSync(opts.file, formatTodo(id, opts.title(s), items));
      throw new AwaitingHumanError(opts.file, items.map((text) => ({ text, done: false, notes: "" })));
    }
    if (existing.items.some((i) => !i.done)) throw new AwaitingHumanError(opts.file, existing.items);

    const archive = path.join(path.dirname(opts.file), "todo", `${id.replace(/[^\w.-]+/g, "-")}.md`);
    mkdirSync(path.dirname(archive), { recursive: true });
    renameSync(opts.file, archive);
    return opts.onAnswers(existing.items, s);
  };
}
