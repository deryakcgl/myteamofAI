# graphwork — agent instructions

This is the single source of truth for every coding agent on this repo (Codex and Cursor read
this file directly; Claude Code reads it through `CLAUDE.md`). Edit here, not in the tool-specific files.

## What this project is
A TypeScript engine that runs multi-agent workflows as graphs. Nodes are agents (the Claude Code, Codex
and Cursor CLIs), edges are explicit routing, and one typed shared state is merged through reducers.
Every loop is a bounded, analyzable cycle.

## Layout
- `src/graph.ts` — `StateGraph` / `CompiledGraph`: superstep execution, reducers, validation, `subgraphNode`, and `analyze()` (the graph as V, E, and loops as strongly connected components with exits and bounds). No agent code here.
- `src/loops.ts` — `validationLoop`: the reusable write → validate → rewrite subgraph, with `loopStart` and `retryNotes`.
- `src/cli-agent.ts` — `cliAgentNode`: runs `claude -p [--agent]`, `codex exec`, or Cursor's `agent -p` as a node, with retries, `onError`, and Claude's sandbox option.
- `src/checkpoint.ts` — `FileCheckpointStore`: the JSON file a run saves its progress to (`run(..., { checkpoint })`; subgraphs nest under their parent's key).
- `src/human.ts` — `humanGate`: writes `TODO.md`, stops the run (`AwaitingHumanError`, parked on its checkpoint), and passes the ticked answers on when resumed. `parseTodo` / `formatTodo`.
- `src/claude-agents.ts` — `writeClaudeAgents`: writes Claude Code subagent files (`.claude/agents/<name>.md`) into a project.
- `src/runner.ts` — `runFromCli` (flags `--json`, `--describe`, `--mermaid`, `--model`, `--resume`, `--fresh`; Ctrl+C aborts and keeps the checkpoint), `projectDir`, and `formatModel`.
- `src/trace.ts` — console tracer.
- `examples/team-of-teams.ts` — the main team: sprints, Definition of Done, product-owner gate, hand-over (see README).
- `prompts/` — ready-made task prompts.
- `desktop/` — Flutter macOS app (`lib/runner.dart` starts the example with `--json`; `lib/main.dart` is the UI, in English).
- `test/` — engine tests.

## Commands
- `npm run typecheck` and `npm test` — must pass before you finish.
- `npx tsx examples/team-of-teams.ts --model` — print the graph's mathematical model, no run.
- `GRAPHWORK_MOCK=1 npx tsx examples/team-of-teams.ts` — dry run, no agent CLIs called.
- `cd desktop && flutter analyze && flutter test` — must pass when you change `desktop/`.
- `cd desktop && flutter build macos` — builds `desktop/build/macos/Build/Products/Release/graphwork.app`.
- Running the team for real uses the user's CLI subscriptions; ask before doing it.

## Rules
- Keep `src/graph.ts` and `src/loops.ts` agent-agnostic; CLI calls go in `src/cli-agent.ts`.
- Spawn CLIs with `execFile` (argument array), never through a shell.
- Nodes return `Partial<State>`; never mutate the state argument.
- A state key written by parallel nodes needs a reducer (the engine throws otherwise).
- Every node needs an outgoing edge; route to `END` explicitly.
- Routers must declare every target they can return, and loop routers should declare a `bound`.
- Every loop needs an exit edge; `compile()` rejects loops without one.
- A subgraph keeps its own state type; pass data in and out only through `subgraphNode`'s `input`/`output`.
- A CLI crash is retried (`retries`, default 2). Give nodes whose failure shouldn't end the run an `onError`.
- A usage limit (`UsageLimitError`) pauses the node until the reset time; it is never treated as a failure or passed to `onError`.
- A stop for the product owner (`AwaitingHumanError`) is a wait, not a failure: exit code 0, checkpoint kept.
- Agents that only judge (comparator, reviewers, handoff writer) don't edit files; changes are made by builders and verified by the test engineer.
- Graph state must stay JSON-serializable, because it is checkpointed.
- Cursor runs are serialized (one `agent` process at a time): its CLI shares one config file.
- Only sandboxed members may run commands (`sandboxCommands` for Claude, Codex's workspace-write sandbox).
- Never point a team at a folder inside this repo: the agents would pick up this AGENTS.md.
- Tests must never call the real agent CLIs; use `GRAPHWORK_MOCK=1` or a fake `command`.
- ESM: import local files with the `.js` extension; no `__dirname`.
- No code comments. Names and small functions explain the code; anything else belongs in README.md or AGENTS.md.
- Keep only what is needed: no dead code, unused files or speculative options.
- Add or update a test in `test/` for any engine behavior change.
