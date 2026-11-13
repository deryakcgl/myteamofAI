# graphwork

A graph engine that runs a team of AI agents like an agile software team. Claude Code subagents plan,
build and test in sprints, Codex and Cursor review each one, and you're the product owner who answers a
to-do list when only a human can help.

## Why I built it
I didn't want to build software in one long chat with one AI. I wanted a real team, with clear roles,
clear hand-offs and one shared state, drawn as a graph.

## How it works: agile sprints
1. **Planning.** An analyst writes the requirements. An architect designs the smallest solution and
   picks the developers the task needs.
2. **Sprint.** The developers build the backlog. A simplifier removes anything unnecessary. A test
   engineer runs the tests.
3. **Review.** Claude's own reviewers check the work, and Codex and Cursor review it independently.
4. **Next backlog.** A comparator weighs all the reviews against the Definition of Done and writes
   the next sprint's backlog.
5. **Check-in with me, the product owner.** After at least 5 sprints, or whenever only a person can
   help, the team stops, writes a hand-over and gives me a to-do list.

## My decisions
- **Claude builds, Codex and Cursor review.** One team, plus two outside opinions.
- **Every step checks itself.** Each step runs in a write → check → rewrite loop. Every loop has an
  exit and a limit, so nothing runs forever.
- **Judges don't build.** Reviewers only decide. Fixes are built and tested in the next sprint.
- **Nothing unnecessary.** Every sprint removes dead code and files nobody needs.
- **"Done, except for what only a human can do."** I get `TODO.md`, tick the items, write my answers,
  then press Continue. The team picks up from where it stopped.
- **A hand-over every time.** `HANDOFF.md` says what was built, how to run it and what is still open.
- **Limits are a pause.** Progress is saved before every step. If a usage limit hits, the team waits
  for the reset and goes on.
- **Existing code isn't rebuilt.** With `--existing`, the team improves what is already there.
- **Safe by default.** Agents run commands only in a sandbox, and project folders stay outside this repo.
- **Clean code.** No comments in the code. If something needs explaining, it goes in the README or `AGENTS.md`.

## Run it
```bash
npm install
npm test
GRAPHWORK_MOCK=1 npx tsx examples/team-of-teams.ts
GRAPHWORK_PROJECT=~/graphwork-projects/my-app npx tsx examples/team-of-teams.ts "Build ..."
GRAPHWORK_PROJECT=~/graphwork-projects/my-app npx tsx examples/team-of-teams.ts --resume
```
- `GRAPHWORK_MOCK=1` is a dry run that calls no agents.
- `--resume` continues a saved run.
- `--model` prints the graph without running it.

A real run uses your Claude Code, Codex and Cursor subscriptions. Each needs installing and signing in once.

## Desktop app (macOS)
```bash
cd desktop && flutter build macos
open build/macos/Build/Products/Release/graphwork.app
```
