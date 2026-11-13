import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  END,
  START,
  StateGraph,
  answersText,
  cliAgentNode,
  humanGate,
  loopStart,
  projectDir,
  reducers,
  retryNotes,
  runFromCli,
  subgraphNode,
  validationLoop,
  writeClaudeAgents,
  type CliAgentSpec,
  type LoopState,
  type SubagentDef,
} from "../src/index.js";

const workspace = projectDir();
const MIN_SPRINTS = 5;
const MAX_SPRINTS = 8;
const PLAN_TRIES = 3;
const CODE_TRIES = 2;
const TEST_FIXES = 2;

const DEFINITION_OF_DONE = [
  "Every requirement and acceptance criterion is met (with evidence).",
  "All tests pass.",
  "No open Critical or High finding.",
  "Nothing unnecessary: no dead or duplicated code, leftover scaffolding, or files the task doesn't need; within any size budget the task sets.",
  "The README says how to build, run and test it.",
]
  .map((d) => `- ${d}`)
  .join("\n");

const ROLES = {
  backend: "server-side code: APIs, data models, storage, business logic",
  "ai-pipeline": "AI/ML parts: model calls, prompts, data processing, embeddings, evaluation",
  frontend: "user interface: pages, components, styling, client-side state",
  developer: "everything else: firmware, CLIs, libraries, scripts, glue code",
} as const;
type Role = keyof typeof ROLES;
const ROLE_ORDER = Object.keys(ROLES) as Role[];

const CHECKER_MODEL = "sonnet";

const REVIEW_RULES =
  "Review the code in the current directory. Do not edit files. List concrete problems only, " +
  "most important first, each with file and line.";

const SUBAGENTS: SubagentDef[] = [
  {
    name: "analyst",
    description: "Turns a task into requirements and checkable acceptance criteria.",
    tools: "read",
    instructions:
      "You are a requirements analyst. Write the requirements and numbered acceptance criteria (AC1, AC2, ...) " +
      "as short bullet points. Each criterion must be checkable. Never write code.",
  },
  {
    name: "system-architect",
    description: "Designs the solution and decides which developer roles are needed.",
    tools: "read",
    instructions:
      "You are the system architect. Design the smallest solution that meets the requirements: components, " +
      "folder layout, interfaces, data flow, and a numbered implementation plan that says what to test. " +
      "Never write code. Then pick only the developer roles the project really needs:\n" +
      ROLE_ORDER.map((r) => `- ${r}: ${ROLES[r]}`).join("\n") +
      '\nEnd with exactly one line like "ROLES: backend, frontend".',
  },
  ...ROLE_ORDER.map((role) => ({
    name: role,
    description: `Implements the ${role} part: ${ROLES[role]}.`,
    tools: "edit" as const,
    instructions:
      `You are the ${role} developer. Your area: ${ROLES[role]}. Implement your part of the plan, or the ` +
      "sprint backlog items in your area, by editing files. Write only what is needed. Do not run shell " +
      "commands; the test engineer builds and tests after you. Build on other developers' work and do not " +
      'rewrite their areas. Finish with a short summary of the files you changed, or "Nothing in my area."',
  })),
  {
    name: "simplifier",
    description: "Removes code and files the project doesn't need, without changing behaviour.",
    tools: "edit",
    instructions:
      "You are the simplifier. Remove what the project doesn't need: dead code, duplicated code (merge it), " +
      "leftover scaffolding and debug output, unused config, and test files named after review rounds or " +
      "sprints (merge them into files named by topic). Keep the behaviour and keep every test that checks a " +
      "requirement. Respect any size budget in the task. Do not run shell commands; the test engineer verifies " +
      "after you. Finish with what you removed or merged and the rough line count saved.",
  },
  {
    name: "test-engineer",
    description: "Writes and runs the automated tests; reports PASS or FAIL.",
    tools: "test",
    instructions:
      "You are the test engineer. Make sure the tests cover the plan's test points and this sprint's changes, " +
      "then build and run all tests. Only add or change test files, never source files. Summarize failures " +
      'with file and line, then end with exactly one line: "TESTS: PASS" or "TESTS: FAIL".',
  },
  {
    name: "validator",
    description: "Checks another agent's work against a checklist; answers VALID: YES or NO.",
    tools: "read",
    model: CHECKER_MODEL,
    instructions:
      "You are the validator. You check another team member's work against the checklist you are given, " +
      "reading the project files where needed. Do not edit files. For each failed check, say what is wrong " +
      "and what would fix it. Be strict but fair: reject only real gaps, not style. End with exactly one " +
      'line: "VALID: YES" or "VALID: NO".',
  },
  {
    name: "verification-analyst",
    description: "Checks each requirement and acceptance criterion against the code.",
    tools: "read",
    model: CHECKER_MODEL,
    instructions: `You are the verification analyst. ${REVIEW_RULES} Go through every requirement and acceptance criterion: met, partly met, or not met, with evidence.`,
  },
  {
    name: "cyber-analyst",
    description: "Screens the code for vulnerabilities and unsafe behaviour.",
    tools: "read",
    model: CHECKER_MODEL,
    instructions:
      `You are the cyber security analyst. ${REVIEW_RULES} Screen for injection, unsafe input handling, ` +
      "hard-coded secrets, insecure defaults, risky dependencies, memory-safety issues, and (for hardware) " +
      "unsafe actuation or missing fail-safes. Rate each finding Critical, High, Medium or Low.",
  },
  {
    name: "quality-reviewer",
    description: "Reviews code quality: bugs, unclear code, missing error handling, anything unnecessary.",
    tools: "read",
    model: CHECKER_MODEL,
    instructions:
      `You are the code quality reviewer. ${REVIEW_RULES} Look for bugs, unclear code, missing error handling, ` +
      "and anything that shouldn't be there: dead or duplicated code, leftover scaffolding, needless files, " +
      "over-engineering beyond the task.",
  },
  {
    name: "comparator",
    description: "Weighs the team's reviews against outside reports and plans the next sprint. Edits nothing.",
    tools: "read",
    instructions:
      "You are the comparator. You get your own team's reviews and independent reports from two other AI " +
      "models (Codex and Cursor). Be critical in both directions: outside reviewers can be wrong, and so can " +
      "your team. You do not edit files: accepted fixes are built and tested in the next sprint. Write:\n" +
      "## Decisions\nA table: each issue, who raised it, your decision (fix / reject / needs product owner), and why.\n" +
      "## Sprint backlog\nOne line per accepted fix, most important first: `- [P1] what to change (role)`.\n" +
      "## Needs the product owner\nOne line per thing no agent can do: a decision about intent, something on " +
      "physical hardware, an account or credential, an install that needs the internet. Phrase each as a " +
      "clear question or action.\n" +
      'Then exactly one line: "STATUS: DONE" if the Definition of Done holds, "STATUS: NEEDS-HUMAN" if only ' +
      'product-owner items are left, or "STATUS: CHANGES" if the backlog has work.',
  },
  {
    name: "handoff-writer",
    description: "Writes the hand-over document for the product owner.",
    tools: "read",
    model: CHECKER_MODEL,
    instructions:
      "You write HANDOFF.md for the product owner, reading the project files where needed. Do not edit files; " +
      "reply with the document's Markdown only. Sections: What it is · How to build, run and test · Status " +
      "against the Definition of Done · Decisions made and why (include rejected findings) · Still open · " +
      "What we need from you · Files. Be concrete and short; no marketing.",
  },
];

function parseRoles(plan: string): Role[] {
  const line = plan.match(/^\s*ROLES:\s*(.+)$/im)?.[1] ?? "";
  const picked = new Set(line.toLowerCase().split(/[\s,]+/));
  const roles = ROLE_ORDER.filter((r) => picked.has(r));
  return roles.length ? roles : ["developer"];
}

function listUnder(heading: RegExp, text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#{1,3}\s/.test(l) && heading.test(l));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line) || /^STATUS:/i.test(line)) break;
    const item = line.match(/^\s*[-*]\s+(.*\S)/)?.[1];
    if (item && !/^\(?none\)?\.?$/i.test(item)) items.push(item);
  }
  return items;
}

const claude = <S>(subagent: string, spec: Omit<CliAgentSpec<S>, "agent" | "subagent" | "cwd">) =>
  cliAgentNode<S>({ agent: "claude", subagent, cwd: workspace, ...spec });

function validatedStage(
  worker: string,
  checklist: string,
  maxIterations: number,
  opts: { canEdit?: boolean; mock: (context: string) => string },
) {
  return validationLoop({
    names: [worker, "validator"],
    maxIterations,
    work: claude<LoopState>(worker, {
      canEdit: opts.canEdit,
      input: (s) => s.context + retryNotes(s),
      output: (draft) => ({ draft }),
      mock: (s) => opts.mock(s.context),
    }),
    check: claude<LoopState>("validator", {
      input: (s) => `# Checklist\n${checklist}\n\n# Context\n${s.context}\n\n# Work to check\n${s.draft}`,
      output: (feedback) => ({ feedback, valid: /VALID:\s*YES/i.test(feedback) }),
      mock: (s) => (s.iteration === 0 ? "1. Missing a check for empty input.\nVALID: NO" : "All checks pass.\nVALID: YES"),
      onError: (e) => ({ feedback: `(validator unavailable: ${e.message})`, valid: false }),
    }),
  });
}

interface PlanningState {
  task: string;
  existing: boolean;
  requirements?: string;
  plan?: string;
}

const EXISTING_NOTE =
  "The project folder already contains an implementation from an earlier run (and possibly reports/ with " +
  "its reviews). Read it before you write anything.";

const planning = new StateGraph<PlanningState>()
  .addNode(
    "requirements",
    subgraphNode(
      validatedStage(
        "analyst",
        "- Every part of the task is covered by a requirement.\n- Acceptance criteria are numbered (AC1, ...).\n" +
          "- Each criterion is objectively checkable (a test or measurement could decide it).\n- No criterion contradicts the task.",
        PLAN_TRIES,
        { mock: () => "- Reads a CSV file\n- Prints JSON\nAC1: valid CSV converts\nAC2: has tests" },
      ),
      {
        input: (p) =>
          loopStart(`Task: ${p.task}${p.existing ? `\n\n${EXISTING_NOTE} Base the requirements on the task, and mark which are already met.` : ""}`),
        output: (c) => ({ requirements: c.draft }),
        maxSteps: 2 * PLAN_TRIES + 1,
      },
    ),
  )
  .addNode(
    "design",
    subgraphNode(
      validatedStage(
        "system-architect",
        "- Every acceptance criterion is addressed by a plan step and a test.\n- Components and interfaces are defined.\n" +
          "- Nothing in the design goes beyond what the requirements need.\n" +
          '- The plan ends with a "ROLES: ..." line naming only roles the project needs.\n- No step is vague ("handle errors" without saying how).',
        PLAN_TRIES,
        { mock: () => "1. src/convert.ts\n2. src/cli.ts\n3. tests\nROLES: backend, developer" },
      ),
      {
        input: (p) =>
          loopStart(
            `Task: ${p.task}\n\nRequirements:\n${p.requirements}` +
              (p.existing
                ? `\n\n${EXISTING_NOTE} Describe the existing design as the plan. Propose changes only where it ` +
                  "doesn't meet the requirements, and say what should be simplified or removed. Don't redesign what works."
                : ""),
          ),
        output: (c) => ({ plan: c.draft }),
        maxSteps: 2 * PLAN_TRIES + 1,
      },
    ),
  )
  .addEdge(START, "requirements")
  .addEdge("requirements", "design")
  .addEdge("design", END)
  .compile();

interface SprintState {
  task: string;
  plan: string;
  sprint: number;
  roles: Role[];
  backlog: string[];
  answers?: string;
  queue: Role[];
  changes: string[];
  simplified: boolean;
  testReport?: string;
  testsPass: boolean;
  fixes: number;
}

const developerStage = (role: Role) =>
  subgraphNode<SprintState, LoopState>(
    validatedStage(
      role,
      `- Read the files the developer changed. Its part (area: ${ROLES[role]}) of the plan or of the sprint backlog is fully done.\n` +
        "- No stubs, TODOs or placeholder logic, and nothing added that the task doesn't need.\n" +
        "- Interfaces match the plan and the other developers' code.\n- Errors and invalid input are handled as the plan says.",
      CODE_TRIES,
      { canEdit: true, mock: () => `${role}: did its part` },
    ),
    {
      input: (b) =>
        loopStart(
          [
            `Task: ${b.task}`,
            `Plan:\n${b.plan}`,
            b.backlog.length ? `# Sprint ${b.sprint} backlog (do the items in your area)\n${b.backlog.map((i) => `- ${i}`).join("\n")}` : "",
            b.answers ? `# The product owner's answers\n${b.answers}` : "",
            `Other developers on this project: ${b.roles.filter((r) => r !== role).join(", ") || "none"}.`,
            b.testReport && !b.testsPass ? `The tests failed; fix the code:\n${b.testReport}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      output: (c, b) => ({ changes: [`${role}: ${c.draft}`], queue: b.queue.slice(1) }),
      maxSteps: 2 * CODE_TRIES + 1,
    },
  );

const sprint = new StateGraph<SprintState>({ reducers: { changes: reducers.append<string>() } })
  .addNode("assign", () => {})
  .addNode("backend", developerStage("backend"))
  .addNode("ai-pipeline", developerStage("ai-pipeline"))
  .addNode("frontend", developerStage("frontend"))
  .addNode("developer", developerStage("developer"))
  .addNode(
    "simplifier",
    claude<SprintState>("simplifier", {
      canEdit: true,
      input: (s) => `Task: ${s.task}\n\nPlan:\n${s.plan}\n\nThis sprint's changes:\n${s.changes.join("\n\n") || "(none)"}`,
      output: (summary) => ({ changes: [`simplifier: ${summary}`], simplified: true }),
      mock: () => "Merged two duplicated parsers; removed a debug script (−40 lines).",
      onError: (e) => ({ changes: [`simplifier: (unavailable: ${e.message})`], simplified: true }),
    }),
  )
  .addNode(
    "test-engineer",
    claude<SprintState>("test-engineer", {
      canEdit: true,
      sandboxCommands: true,
      input: (s) => `Plan:\n${s.plan}\n\nThis sprint's changes:\n${s.changes.join("\n\n") || "(none)"}`,
      output: (testReport, s) => {
        const testsPass = /TESTS:\s*PASS/i.test(testReport);
        return { testReport, testsPass, fixes: s.fixes + 1, queue: testsPass ? [] : ["developer"] };
      },
      mock: (s) => (s.sprint === 1 && s.fixes === 0 ? "1 test failed: empty file\nTESTS: FAIL" : "All tests pass\nTESTS: PASS"),
      onError: (e, s) => ({ testReport: `The test run could not complete: ${e.message}`, testsPass: false, fixes: s.fixes + 1, queue: ["developer"] }),
    }),
  )
  .addEdge(START, "assign")
  .addConditionalEdges(
    "assign",
    (s) => s.queue[0] ?? (s.simplified ? "test-engineer" : "simplifier"),
    [...ROLE_ORDER, "simplifier", "test-engineer"],
    { bound: "number of roles + fixes" },
  )
  .addEdge("backend", "assign")
  .addEdge("ai-pipeline", "assign")
  .addEdge("frontend", "assign")
  .addEdge("developer", "assign")
  .addEdge("simplifier", "test-engineer")
  .addConditionalEdges("test-engineer", (s) => (s.testsPass || s.fixes >= TEST_FIXES ? END : "assign"), ["assign", END], {
    bound: TEST_FIXES,
  })
  .compile();

interface AuditState {
  task: string;
  requirements: string;
  plan: string;
  testReport: string;
  claudeReviews: string[];
  codexReport?: string;
  cursorReport?: string;
}

const context = (s: Readonly<AuditState>) =>
  `Task: ${s.task}\n\nRequirements:\n${s.requirements}\n\nPlan:\n${s.plan}\n\nLatest test report:\n${s.testReport}`;

const claudeReviewer = (name: string, mock: string) =>
  claude<AuditState>(name, {
    input: context,
    output: (text) => ({ claudeReviews: [`## ${name}\n${text}`] }),
    mock: () => mock,
    onError: (e) => ({ claudeReviews: [`## ${name}\n(unavailable: ${e.message})`] }),
  });

const OUTSIDE_BRIEF =
  "You are an independent reviewer from outside the team that built this project. Review the code in the " +
  "current directory. Do not edit files. Write a report: requirements met or not, bugs, vulnerabilities " +
  "(rated Critical/High/Medium/Low), anything that isn't needed, and anything the team is likely to have " +
  "missed. Be specific: file and line.";

const audit = new StateGraph<AuditState>({ reducers: { claudeReviews: reducers.append<string>() } })
  .addNode("verification", claudeReviewer("verification-analyst", "AC1 met, AC2 met."))
  .addNode("cyber", claudeReviewer("cyber-analyst", "Low: validate the input path."))
  .addNode("quality", claudeReviewer("quality-reviewer", "No major issues."))
  .addNode(
    "codex-report",
    cliAgentNode({
      agent: "codex",
      cwd: workspace,
      input: (s) => `${OUTSIDE_BRIEF}\n\n${context(s)}`,
      output: (codexReport) => ({ codexReport }),
      mock: () => "Medium: empty input file crashes the CLI (src/cli.ts:12).",
      onError: (e) => ({ codexReport: `(Codex report unavailable: ${e.message})` }),
    }),
  )
  .addNode(
    "cursor-report",
    cliAgentNode({
      agent: "cursor",
      cwd: workspace,
      trustWorkspace: true,
      input: (s) => `${OUTSIDE_BRIEF}\n\n${context(s)}`,
      output: (cursorReport) => ({ cursorReport }),
      mock: () => "Low: README lacks usage examples.",
      onError: (e) => ({ cursorReport: `(Cursor report unavailable: ${e.message})` }),
    }),
  )
  .addNode("collect", () => {})
  .addEdge(START, ["verification", "cyber", "quality", "codex-report", "cursor-report"])
  .addEdge("verification", "collect")
  .addEdge("cyber", "collect")
  .addEdge("quality", "collect")
  .addEdge("codex-report", "collect")
  .addEdge("cursor-report", "collect")
  .addEdge("collect", END)
  .compile();

type Status = "DONE" | "CHANGES" | "NEEDS-HUMAN";

interface ProjectState {
  task: string;
  existing: boolean;
  requirements?: string;
  plan?: string;
  roles: Role[];
  sprint: number;
  sinceOwner: number;
  backlog: string[];
  ownerItems: string[];
  answers?: string;
  accepted: boolean;
  changes?: string;
  testReport?: string;
  testsPass: boolean;
  claudeReviews?: string;
  codexReport?: string;
  cursorReport?: string;
  comparison?: string;
  status: Status;
  history: string[];
}

const APPROVAL_ITEM = (s: Readonly<ProjectState>) =>
  `Review HANDOFF.md: the team stopped after ${s.sprint} sprints without meeting the Definition of Done. ` +
  `Write "accept" to finish as it is, or write what should change; that goes into the next sprint.`;

const project = new StateGraph<ProjectState>()
  .addNode(
    "planning",
    subgraphNode(planning, {
      input: (p) => ({ task: p.task, existing: p.existing }),
      output: (c) => ({ requirements: c.requirements, plan: c.plan, roles: parseRoles(c.plan ?? "") }),
    }),
  )
  .addNode(
    "sprint",
    subgraphNode(sprint, {
      input: (p) => {
        const work = p.sprint === 0 ? !p.existing : p.backlog.length > 0;
        return {
          task: p.task,
          plan: p.plan ?? "",
          sprint: p.sprint + 1,
          roles: p.roles,
          backlog: p.backlog,
          answers: p.answers,
          queue: work ? p.roles : [],
          changes: [],
          simplified: false,
          testsPass: false,
          fixes: 0,
        };
      },
      output: (c, p) => ({
        changes: c.changes.join("\n\n"),
        testReport: c.testReport,
        testsPass: c.testsPass,
        sprint: p.sprint + 1,
        sinceOwner: p.sinceOwner + 1,
        history: [...p.history, `Sprint ${p.sprint + 1}: ${p.backlog.length ? p.backlog.join("; ") : p.sprint === 0 ? (p.existing ? "simplified and tested the existing code" : "built the plan") : "review-only sprint"}`],
      }),
      maxSteps: 40,
    }),
  )
  .addNode(
    "audit",
    subgraphNode(audit, {
      input: (p) => ({
        task: p.task,
        requirements: p.requirements ?? "",
        plan: p.plan ?? "",
        testReport: p.testReport ?? "(no test report)",
        claudeReviews: [],
      }),
      output: (c) => ({ claudeReviews: c.claudeReviews.join("\n\n"), codexReport: c.codexReport, cursorReport: c.cursorReport }),
    }),
  )
  .addNode(
    "triage",
    subgraphNode<ProjectState, LoopState>(
      validatedStage(
        "comparator",
        "- Every issue from all five reports appears in the decision table.\n" +
          "- No Critical or High issue is rejected without a strong, specific reason.\n" +
          "- Each accepted fix is a concrete, testable backlog line with a role.\n" +
          "- Product-owner items are only things no agent can do, each a clear question or action.\n" +
          "- The STATUS line follows from the lists and the Definition of Done.",
        CODE_TRIES,
        {
          mock: (ctx) => {
            const n = Number(ctx.match(/^Sprint (\d+)/m)?.[1] ?? 1);
            const answered = ctx.includes("# The product owner's answers");
            if (n === 1) return "## Decisions\n| empty input | Codex | fix |\n## Sprint backlog\n- [P1] Handle an empty input file (developer)\n## Needs the product owner\n- (none)\nSTATUS: CHANGES";
            if (n === 2 && !answered) return "## Decisions\n| output format | verification | needs product owner |\n## Sprint backlog\n## Needs the product owner\n- Should the JSON be pretty-printed by default?\nSTATUS: NEEDS-HUMAN";
            return "## Decisions\n| README examples | Cursor | fix |\n## Sprint backlog\n## Needs the product owner\nSTATUS: DONE";
          },
        },
      ),
      {
        input: (p) =>
          loopStart(
            [
              `Sprint ${p.sprint} finished (at least ${MIN_SPRINTS} sprints run).`,
              `Task: ${p.task}`,
              `Requirements:\n${p.requirements}`,
              `# Definition of Done\n${DEFINITION_OF_DONE}`,
              p.answers ? `# The product owner's answers\n${p.answers}` : "",
              `Latest test report:\n${p.testReport}`,
              `What this sprint changed:\n${p.changes}`,
              `# Your team's reviews (Claude)\n${p.claudeReviews}`,
              `# Outside report 1 (Codex)\n${p.codexReport}`,
              `# Outside report 2 (Cursor)\n${p.cursorReport}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        output: (c) => {
          const comparison = c.draft ?? "(no decision)";
          const backlog = listUnder(/sprint backlog/i, comparison);
          const ownerItems = listUnder(/product owner/i, comparison);
          const status: Status = backlog.length
            ? "CHANGES"
            : ownerItems.length
              ? "NEEDS-HUMAN"
              : /STATUS:\s*DONE/i.test(comparison)
                ? "DONE"
                : "CHANGES";
          return { comparison, backlog, ownerItems, status };
        },
        maxSteps: 2 * CODE_TRIES + 1,
      },
    ),
  )
  .addNode("record", async (s) => {
    await mkdir(path.join(workspace, "reports"), { recursive: true });
    await writeFile(
      path.join(workspace, "reports", `sprint-${s.sprint}.md`),
      [
        `# Sprint ${s.sprint}`,
        `## What changed\n${s.changes}`,
        `## Tests\n${s.testReport}`,
        `## Claude team reviews\n${s.claudeReviews}`,
        `## Codex report\n${s.codexReport}`,
        `## Cursor report\n${s.cursorReport}`,
        `## Triage\n${s.comparison}`,
      ].join("\n\n"),
    );
    const list = (items: string[]) => (items.length ? items.map((i) => `- [ ] ${i}`).join("\n") : "(none)");
    await writeFile(
      path.join(workspace, "BACKLOG.md"),
      [
        `# Backlog (after sprint ${s.sprint}, status ${s.status})`,
        `## Next sprint\n${list(s.backlog)}`,
        `## Needs the product owner\n${list(s.ownerItems)}`,
        `## Definition of Done\n${DEFINITION_OF_DONE}`,
        `## History\n${s.history.map((h) => `- ${h}`).join("\n")}`,
      ].join("\n\n") + "\n",
    );
  })
  .addNode(
    "handoff",
    claude<ProjectState>("handoff-writer", {
      input: (s) =>
        [
          `Task: ${s.task}`,
          `Requirements:\n${s.requirements}`,
          `# Definition of Done\n${DEFINITION_OF_DONE}`,
          `Status after ${s.sprint} sprints: ${s.status}`,
          `Latest test report:\n${s.testReport}`,
          `Latest triage:\n${s.comparison}`,
          `Sprint history:\n${s.history.join("\n")}`,
        ].join("\n\n"),
      output: (doc) => (writeFileSync(path.join(workspace, "HANDOFF.md"), `${doc}\n`), {}),
      mock: (s) => `# Handoff\n\nStatus after ${s.sprint} sprints: ${s.status}.`,
      onError: (e, s) => {
        writeFileSync(
          path.join(workspace, "HANDOFF.md"),
          `# Handoff (automatic: the writer was unavailable: ${e.message})\n\nStatus after ${s.sprint} sprints: ${s.status}\n\n` +
            `## Latest triage\n${s.comparison}\n\n## Latest tests\n${s.testReport}\n`,
        );
        return {};
      },
    }),
  )
  .addNode(
    "owner",
    humanGate<ProjectState>({
      file: path.join(workspace, "TODO.md"),
      id: (s) => `sprint-${s.sprint}`,
      title: (s) => `To do for you (after sprint ${s.sprint})`,
      items: (s) => (s.status === "DONE" ? [] : s.ownerItems.length ? s.ownerItems : [APPROVAL_ITEM(s)]),
      onAnswers: (items, s) => {
        const accepted = items.length === 1 && items[0]!.text === APPROVAL_ITEM(s) && /^\s*accept\b/i.test(items[0]!.notes);
        return { answers: answersText(items), ownerItems: [], sinceOwner: 0, accepted, backlog: accepted ? [] : s.backlog };
      },
    }),
  )
  .addEdge(START, "planning")
  .addEdge("planning", "sprint")
  .addEdge("sprint", "audit")
  .addEdge("audit", "triage")
  .addEdge("triage", "record")
  .addConditionalEdges(
    "record",
    (s) => {
      if (s.status === "DONE" && s.testsPass && s.sprint >= MIN_SPRINTS) return "handoff";
      if (s.status === "NEEDS-HUMAN") return "handoff";
      if (s.sinceOwner >= MAX_SPRINTS) return "handoff";
      return "sprint";
    },
    ["sprint", "handoff"],
    { bound: `${MIN_SPRINTS}..${MAX_SPRINTS} sprints per check-in` },
  )
  .addConditionalEdges("handoff", (s) => (s.status === "DONE" && s.testsPass && s.sprint >= MIN_SPRINTS ? END : "owner"), ["owner", END])
  .addConditionalEdges("owner", (s) => (s.accepted ? END : "sprint"), ["sprint", END], { bound: "until you accept" })
  .compile();

await runFromCli(project, {
  initial: (task) => ({
    task,
    existing: process.argv.includes("--existing"),
    roles: [],
    sprint: 0,
    sinceOwner: 0,
    backlog: [],
    ownerItems: [],
    accepted: false,
    testsPass: false,
    status: "CHANGES" as Status,
    history: [],
  }),
  defaultTask: "Build a small Node.js CLI that converts a CSV file to JSON, with tests.",
  maxSteps: 200,
  checkpointFile: path.join(workspace, ".graphwork", "checkpoint.json"),
  prepare: async () => {
    await mkdir(workspace, { recursive: true });
    await writeClaudeAgents(workspace, SUBAGENTS);
  },
  summary: (s) =>
    `Done · ${s.sprint} sprints · roles=${s.roles.join(", ")} · tests pass=${s.testsPass} · status ${s.status}` +
    `${s.accepted ? " · accepted by you" : ""}\nCode is in: ${workspace}\nHand-over: ${workspace}/HANDOFF.md`,
});
