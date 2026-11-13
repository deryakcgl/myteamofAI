import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { END, START, type CompiledGraph, type GraphEvent, type GraphModel } from "./graph.js";
import { FileCheckpointStore } from "./checkpoint.js";
import { AwaitingHumanError } from "./human.js";
import { consoleTracer } from "./trace.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function projectDir(): string {
  const dir = path.resolve(process.env.GRAPHWORK_PROJECT || path.join(homedir(), "graphwork-projects", "default"));
  const rel = path.relative(REPO_ROOT, dir);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(`Project folder ${dir} is inside graphwork (${REPO_ROOT}); pick a folder outside it`);
  }
  return dir;
}

export interface CliRunOptions<S> {
  initial: (task: string) => S;
  defaultTask: string;
  maxSteps?: number;
  prepare?: () => Promise<void>;
  summary: (state: S) => string;
  checkpointFile?: string;
}

export async function runFromCli<S extends object>(graph: CompiledGraph<S>, opts: CliRunOptions<NoInfer<S>>) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")).map((f) => (f === "--continue" ? "--resume" : f)));
  const task = args.filter((a) => !a.startsWith("--")).join(" ") || opts.defaultTask;

  if (flags.has("--mermaid")) return console.log(graph.toMermaid());
  if (flags.has("--describe")) return console.log(JSON.stringify(graph.describe()));
  if (flags.has("--model")) return console.log(formatModel(graph.analyze()));

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

  const json = flags.has("--json");
  const emit = (e: object) => process.stdout.write(JSON.stringify(e) + "\n");
  const tracer = json ? undefined : consoleTracer();

  try {
    const checkpoint = openCheckpoint(opts.checkpointFile, flags);
    if (!process.env.GRAPHWORK_MOCK) keepAwake();
    await opts.prepare?.();
    const { state, steps } = await graph.run(opts.initial(task), {
      maxSteps: opts.maxSteps,
      signal: controller.signal,
      checkpoint,
      onEvent: json ? (e) => emitEvent(e, emit) : tracer!.onEvent,
    });
    if (json) emit({ type: "done", steps, state });
    else console.log(`\n${opts.summary(state)}`);
  } catch (error) {
    if (error instanceof AwaitingHumanError) {
      if (json) emit({ type: "awaiting_human", file: error.file, items: error.items });
      else {
        console.log(`\n⏸ ${error.message}\n`);
        for (const i of error.items) console.log(`  ${i.done ? "[x]" : "[ ]"} ${i.text}`);
        console.log(`\nWhen they're all ticked, run the same command with --resume.`);
      }
      return;
    }
    const message = controller.signal.aborted ? "Stopped" : error instanceof Error ? error.message : String(error);
    if (json) emit({ type: "error", message });
    else console.error(`\n✖ ${message}`);
    process.exitCode = 1;
  }
}

function openCheckpoint(file: string | undefined, flags: Set<string>) {
  if (!file) return undefined;
  const saved = existsSync(file);
  if (flags.has("--resume") && !saved) throw new Error(`Nothing to resume: no checkpoint at ${file}`);
  if (saved && flags.has("--fresh")) rmSync(file);
  else if (saved && !flags.has("--resume")) {
    throw new Error(`An interrupted run is saved at ${file}. Run again with --resume to continue it, or --fresh to start over.`);
  }
  return { store: new FileCheckpointStore(file), key: "run" };
}

function keepAwake() {
  if (process.platform !== "darwin") return;
  const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

function emitEvent(e: GraphEvent, emit: (e: object) => void) {
  switch (e.type) {
    case "node_start":
      return emit({ type: e.type, node: e.node });
    case "node_end":
      return emit({ type: e.type, node: e.node, ms: e.ms, wrote: Object.keys(e.update) });
    case "route":
      return emit({ type: e.type, from: e.from, to: e.to });
    case "log":
      return emit({ type: e.type, node: e.node, message: e.message });
    default:
      return undefined;
  }
}

export function formatModel(m: GraphModel, name = "G", indent = ""): string {
  const v = (n: string) => (n === START ? "START" : n === END ? "END" : n);
  const edge = (e: GraphModel["edges"][number]) =>
    `${v(e.from)} ${e.routed ? "⇢" : "→"} ${v(e.to)}${e.bound !== undefined ? ` [bound ${e.bound}]` : ""}`;
  const lines = [
    `${name} = (V, E),  |V| = ${m.vertices.length},  |E| = ${m.edges.length},  ${m.acyclic ? "acyclic" : `${m.cycles.length} loop(s)`}`,
    `  V = { ${m.vertices.map(v).join(", ")} }`,
    `  E = { ${m.edges.map(edge).join(",  ")} }`,
    ...m.cycles.map(
      (c, i) =>
        `  L${i + 1} = { ${c.nodes.join(", ")} }   exits: ${c.exits.map((e) => `${v(e.from)} → ${v(e.to)}`).join(", ")}` +
        `   bound: ${c.bound ?? "maxSteps only"}`,
    ),
  ].map((l) => indent + l);
  for (const [node, child] of Object.entries(m.subgraphs)) {
    lines.push("", formatModel(child, `${name}.${node}`, indent + "    "));
  }
  return lines.join("\n");
}
