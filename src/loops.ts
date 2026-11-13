import { END, START, StateGraph, annotateNode, getNodeMeta, type CompiledGraph, type NodeFn } from "./graph.js";

export interface LoopState {
  context: string;
  draft?: string;
  feedback?: string;
  valid: boolean;
  iteration: number;
}

export const loopStart = (context: string): LoopState => ({ context, valid: false, iteration: 0 });

export function validationLoop(opts: {
  work: NodeFn<LoopState>;
  check: NodeFn<LoopState>;
  maxIterations: number;
  names?: [string, string];
}): CompiledGraph<LoopState> {
  const [work, check] = opts.names ?? ["work", "check"];
  const counted = annotateNode<NodeFn<LoopState>>(
    async (s, ctx) => ({ ...((await opts.check(s, ctx)) ?? {}), iteration: s.iteration + 1 }),
    getNodeMeta(opts.check) ?? {},
  );
  return new StateGraph<LoopState>()
    .addNode(work, opts.work)
    .addNode(check, counted)
    .addEdge(START, work)
    .addEdge(work, check)
    .addConditionalEdges(check, (s) => (s.valid || s.iteration >= opts.maxIterations ? END : work), [work, END], {
      bound: opts.maxIterations,
    })
    .compile();
}

export function retryNotes(s: Readonly<LoopState>): string {
  if (!s.feedback || s.valid) return "";
  return `\n\n# Your previous attempt was rejected by the validator\n${s.feedback}\n\nFix every point it raised.` +
    (s.draft ? `\n\n# Your previous attempt\n${s.draft}` : "");
}
