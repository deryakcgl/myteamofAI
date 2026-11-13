export const START = "__start__";
export const END = "__end__";

export type Reducer<V> = (current: V, update: V) => V;
export type Reducers<S> = { [K in keyof S]?: Reducer<S[K]> };

export const reducers = {
  append:
    <T>(): Reducer<T[]> =>
    (current, update) => [...(current ?? []), ...(update ?? [])],
  merge:
    <T extends object>(): Reducer<T> =>
    (current, update) => ({ ...current, ...update }),
  sum: (): Reducer<number> => (current, update) => (current ?? 0) + (update ?? 0),
};

export type GraphEvent =
  | { type: "step_start"; step: number; frontier: string[] }
  | { type: "node_start"; step: number; node: string }
  | { type: "node_end"; step: number; node: string; update: object; ms: number }
  | { type: "route"; step: number; from: string; to: string[] }
  | { type: "step_end"; step: number; state: unknown }
  | { type: "log"; node: string; message: string; data?: unknown };

export interface NodeContext {
  node: string;
  step: number;
  signal?: AbortSignal;
  emit: (event: GraphEvent) => void;
  checkpoint?: CheckpointRef;
}

export interface CheckpointStore {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
  clear(key: string): void;
}

export interface CheckpointRef {
  store: CheckpointStore;
  key: string;
}

interface Saved<S> {
  state: S;
  frontier: string[];
  step: number;
}

export type NodeFn<S> = (
  state: Readonly<S>,
  ctx: NodeContext,
) => Partial<S> | void | Promise<Partial<S> | void>;

export type Router<S> = (
  state: Readonly<S>,
  ctx: NodeContext,
) => string | string[] | Promise<string | string[]>;

type Outgoing<S> =
  | { kind: "static"; to: string[] }
  | { kind: "router"; router: Router<S>; targets: string[]; bound?: Bound };

export type Bound = number | string;

export class GraphError extends Error {}

export class StateGraph<S extends object> {
  private nodes = new Map<string, NodeFn<S>>();
  private edges = new Map<string, Outgoing<S>>();

  constructor(private opts: { reducers?: Reducers<S> } = {}) {}

  addNode(name: string, fn: NodeFn<S>): this {
    if (name === START || name === END) throw new GraphError(`"${name}" is reserved`);
    if (this.nodes.has(name)) throw new GraphError(`Duplicate node "${name}"`);
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from: string, to: string | string[]): this {
    this.setOutgoing(from, { kind: "static", to: [to].flat() });
    return this;
  }

  addConditionalEdges(from: string, router: Router<S>, targets: string[], opts: { bound?: Bound } = {}): this {
    this.setOutgoing(from, { kind: "router", router, targets, bound: opts.bound });
    return this;
  }

  compile(): CompiledGraph<S> {
    if (!this.edges.has(START)) throw new GraphError("No entry point: add an edge from START");
    for (const [from, out] of this.edges) {
      if (from !== START && !this.nodes.has(from)) throw new GraphError(`Edge from unknown node "${from}"`);
      const targets = out.kind === "static" ? out.to : out.targets;
      for (const t of targets) {
        if (t !== END && !this.nodes.has(t)) throw new GraphError(`Edge "${from}" -> unknown node "${t}"`);
      }
    }
    for (const name of this.nodes.keys()) {
      if (!this.edges.has(name)) {
        throw new GraphError(`Node "${name}" has no outgoing edge (route it to END explicitly)`);
      }
    }
    const graph = new CompiledGraph(new Map(this.nodes), new Map(this.edges), this.opts.reducers ?? {});
    for (const cycle of graph.analyze().cycles) {
      if (cycle.exits.length === 0) {
        throw new GraphError(`Loop {${cycle.nodes.join(", ")}} has no exit; add a routed edge out of it`);
      }
    }
    return graph;
  }

  private setOutgoing(from: string, out: Outgoing<S>) {
    if (from === END) throw new GraphError("END cannot have outgoing edges");
    if (this.edges.has(from)) throw new GraphError(`Node "${from}" already has an outgoing edge`);
    this.edges.set(from, out);
  }
}

export interface RunOptions {
  maxSteps?: number;
  onEvent?: (event: GraphEvent) => void;
  signal?: AbortSignal;
  checkpoint?: CheckpointRef;
}

export interface RunResult<S> {
  state: S;
  steps: number;
  path: string[][];
}

export class CompiledGraph<S extends object> {
  constructor(
    private nodes: Map<string, NodeFn<S>>,
    private edges: Map<string, Outgoing<S>>,
    private reducers: Reducers<S>,
  ) {}

  async run(initial: S, opts: RunOptions = {}): Promise<RunResult<S>> {
    const maxSteps = opts.maxSteps ?? 25;
    const emit = opts.onEvent ?? (() => {});
    const cp = opts.checkpoint;
    const path: string[][] = [];
    let state: S, frontier: string[], step: number;

    const saved = cp?.store.load(cp.key) as Saved<S> | undefined;
    if (saved) {
      ({ state, frontier, step } = saved);
      emit({ type: "log", node: "checkpoint", message: `resuming at step ${step + 1}: [${frontier.join(", ")}]` });
    } else {
      state = { ...initial };
      frontier = await this.next(START, state, { node: START, step: 0, signal: opts.signal, emit });
      step = 0;
    }

    while (frontier.length > 0) {
      cp?.store.save(cp.key, { state, frontier, step } satisfies Saved<S>);
      if (step >= maxSteps) {
        throw new GraphError(`Exceeded maxSteps=${maxSteps}; frontier was [${frontier.join(", ")}]`);
      }
      opts.signal?.throwIfAborted();
      step++;
      emit({ type: "step_start", step, frontier });
      path.push(frontier);

      const snapshot = Object.freeze({ ...state }) as Readonly<S>;
      const results = await Promise.all(
        frontier.map(async (name) => {
          const ctx: NodeContext = { node: name, step, signal: opts.signal, emit, checkpoint: cp };
          emit({ type: "node_start", step, node: name });
          const t0 = Date.now();
          const update = (await this.nodes.get(name)!(snapshot, ctx)) ?? {};
          emit({ type: "node_end", step, node: name, update, ms: Date.now() - t0 });
          return { name, update, ctx };
        }),
      );

      state = this.merge(state, results);
      emit({ type: "step_end", step, state });

      const nextSet = new Set<string>();
      for (const { name, ctx } of results) {
        for (const t of await this.next(name, state, ctx)) nextSet.add(t);
      }
      frontier = [...nextSet];
    }

    cp?.store.clear(cp.key);
    return { state, steps: step, path };
  }

  describe(): GraphDescription {
    return {
      nodes: [...this.nodes].map(([name, fn]) => {
        const child = subgraphs.get(fn as NodeFn<unknown>);
        return { name, meta: nodeMeta.get(fn as NodeFn<unknown>), ...(child ? { children: child.describe() } : {}) };
      }),
      edges: [...this.edges].flatMap(([from, out]) =>
        (out.kind === "static" ? out.to : out.targets).map((to) => ({
          from,
          to,
          routed: out.kind === "router",
          ...(out.kind === "router" && out.bound !== undefined ? { bound: out.bound } : {}),
        })),
      ),
    };
  }

  analyze(): GraphModel {
    const { edges } = this.describe();
    const vertices = [START, ...this.nodes.keys(), END];
    const succ = new Map(vertices.map((v) => [v, edges.filter((e) => e.from === v).map((e) => e.to)]));

    let index = 0;
    const idx = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
    const stack: string[] = [], sccs: string[][] = [];
    const visit = (v: string) => {
      idx.set(v, index);
      low.set(v, index++);
      stack.push(v);
      onStack.add(v);
      for (const w of succ.get(v)!) {
        if (!idx.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      }
      if (low.get(v) === idx.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        sccs.push(scc.reverse());
      }
    };
    for (const v of vertices) if (!idx.has(v)) visit(v);

    const cycles = sccs
      .filter((c) => c.length > 1 || succ.get(c[0]!)!.includes(c[0]!))
      .map((nodes) => {
        const inside = new Set(nodes);
        const exits = edges.filter((e) => inside.has(e.from) && !inside.has(e.to)).map(({ from, to }) => ({ from, to }));
        const bound = edges.find((e) => inside.has(e.from) && e.bound !== undefined)?.bound;
        return { nodes, exits, ...(bound !== undefined ? { bound } : {}) };
      });

    const subgraphModels: Record<string, GraphModel> = {};
    for (const [name, fn] of this.nodes) {
      const child = subgraphs.get(fn as NodeFn<unknown>);
      if (child) subgraphModels[name] = child.analyze();
    }
    return { vertices, edges, cycles, acyclic: cycles.length === 0, subgraphs: subgraphModels };
  }

  toMermaid(): string {
    return ["flowchart TD", "  START([start])", "  END([end])", ...this.mermaidBody("", "  ")].join("\n");
  }

  mermaidBody(prefix: string, indent: string): string[] {
    const id = (n: string) => {
      if (!prefix) return n === START ? "START" : n === END ? "END" : n;
      return `${prefix}__${n === START ? "in" : n === END ? "out" : n}`;
    };
    const lines: string[] = [];
    if (prefix) lines.push(`${indent}${id(START)}(( )):::port`, `${indent}${id(END)}(( )):::port`);
    for (const [name, fn] of this.nodes) {
      const child = subgraphs.get(fn as NodeFn<unknown>);
      if (child) {
        lines.push(`${indent}subgraph ${id(name)} [${name}]`, ...child.mermaidBody(id(name), indent + "  "), `${indent}end`);
      } else {
        lines.push(`${indent}${id(name)}[${name}]`);
      }
    }
    for (const [from, out] of this.edges) {
      const targets = out.kind === "static" ? out.to : out.targets;
      const arrow = out.kind === "static" ? "-->" : "-.->";
      for (const t of targets) lines.push(`${indent}${id(from)} ${arrow} ${id(t)}`);
    }
    if (!prefix && lines.some((l) => l.includes(":::port"))) lines.push("  classDef port fill:#999,stroke:#999");
    return lines;
  }

  private async next(from: string, state: S, ctx: NodeContext): Promise<string[]> {
    const out = this.edges.get(from)!;
    let to: string[];
    if (out.kind === "static") {
      to = out.to;
    } else {
      to = [await out.router(state, ctx)].flat();
      for (const t of to) {
        if (!out.targets.includes(t)) {
          throw new GraphError(`Router on "${from}" returned "${t}", not one of [${out.targets.join(", ")}]`);
        }
      }
    }
    ctx.emit({ type: "route", step: ctx.step, from, to });
    return to.filter((t) => t !== END);
  }

  private merge(state: S, results: { name: string; update: Partial<S> }[]): S {
    const merged: S = { ...state };
    const writtenBy = new Map<keyof S, string>();
    for (const { name, update } of results) {
      for (const key of Object.keys(update) as (keyof S)[]) {
        const value = update[key] as S[keyof S];
        const reducer = this.reducers[key];
        if (reducer) {
          merged[key] = reducer(merged[key], value);
        } else {
          const prev = writtenBy.get(key);
          if (prev) {
            throw new GraphError(
              `Nodes "${prev}" and "${name}" both wrote "${String(key)}" in the same step; give it a reducer`,
            );
          }
          merged[key] = value;
        }
        writtenBy.set(key, name);
      }
    }
    return merged;
  }
}

export interface NodeMeta {
  agent?: string;
}

export interface GraphDescription {
  nodes: { name: string; meta?: NodeMeta; children?: GraphDescription }[];
  edges: GraphEdge[];
}

export interface GraphEdge {
  from: string;
  to: string;
  routed: boolean;
  bound?: Bound;
}

export interface GraphModel {
  vertices: string[];
  edges: GraphEdge[];
  cycles: { nodes: string[]; exits: { from: string; to: string }[]; bound?: Bound }[];
  acyclic: boolean;
  subgraphs: Record<string, GraphModel>;
}

const nodeMeta = new WeakMap<NodeFn<unknown>, NodeMeta>();

export const getNodeMeta = (fn: NodeFn<any>): NodeMeta | undefined => nodeMeta.get(fn as NodeFn<unknown>);

export function annotateNode<F extends NodeFn<any>>(fn: F, meta: NodeMeta): F {
  nodeMeta.set(fn as NodeFn<unknown>, meta);
  return fn;
}

const subgraphs = new WeakMap<NodeFn<unknown>, CompiledGraph<any>>();

export interface SubgraphSpec<P, C> {
  input: (parent: Readonly<P>) => C;
  output: (child: C, parent: Readonly<P>) => Partial<P>;
  maxSteps?: number;
}

export function subgraphNode<P extends object, C extends object>(
  graph: CompiledGraph<C>,
  spec: SubgraphSpec<P, NoInfer<C>>,
): NodeFn<P> {
  const fn: NodeFn<P> = async (state, ctx) => {
    const { state: child } = await graph.run(spec.input(state), {
      maxSteps: spec.maxSteps,
      signal: ctx.signal,
      checkpoint: ctx.checkpoint && { store: ctx.checkpoint.store, key: `${ctx.checkpoint.key}/${ctx.node}` },
      onEvent: (e) => {
        const forwarded = prefixEvent(e, ctx.node);
        if (forwarded) ctx.emit(forwarded);
      },
    });
    return spec.output(child, state);
  };
  subgraphs.set(fn as NodeFn<unknown>, graph);
  return fn;
}

function prefixEvent(e: GraphEvent, parent: string): GraphEvent | undefined {
  const name = (n: string) => (n === END ? END : `${parent}/${n}`);
  switch (e.type) {
    case "node_start":
    case "node_end":
    case "log":
      return { ...e, node: name(e.node) };
    case "route":
      return e.from === START ? undefined : { ...e, from: name(e.from), to: e.to.map(name) };
    default:
      return undefined;
  }
}
