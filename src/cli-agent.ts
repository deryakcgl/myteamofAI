import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { annotateNode, type NodeContext, type NodeFn } from "./graph.js";

export type CliAgent = "claude" | "codex" | "cursor";

export interface CliAgentSpec<S> {
  agent: CliAgent;
  input: (state: Readonly<S>) => string;
  output: (text: string, state: Readonly<S>) => Partial<S>;
  cwd?: string;
  canEdit?: boolean;
  canRunCommands?: boolean;
  sandboxCommands?: boolean;
  subagent?: string;
  trustWorkspace?: boolean;
  timeoutMs?: number;
  command?: string;
  mock?: (state: Readonly<S>) => string;
  retries?: number;
  retryDelayMs?: number;
  onError?: (error: CliAgentError, state: Readonly<S>) => Partial<S>;
}

export class CliAgentError extends Error {}

const EXCLUSIVE: ReadonlySet<CliAgent> = new Set(["cursor"]);

const DEFAULT_COMMAND: Record<CliAgent, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "agent",
};

export function cliAgentNode<S>(spec: CliAgentSpec<S>): NodeFn<S> {
  return annotateNode<NodeFn<S>>(async (state, ctx) => {
    const prompt = spec.input(state);
    let text: string;
    try {
      text = process.env.GRAPHWORK_MOCK ? await mockReply(spec, state, prompt, ctx) : await runWithRetries(spec, prompt, ctx);
    } catch (error) {
      if (!(error instanceof CliAgentError) || !spec.onError || ctx.signal?.aborted) throw error;
      ctx.emit({ type: "log", node: ctx.node, message: `${spec.agent} gave up, continuing: ${error.message}` });
      return spec.onError(error, state);
    }
    ctx.emit({ type: "log", node: ctx.node, message: `${spec.agent} replied (${text.length} chars)` });
    return spec.output(text, state);
  }, { agent: spec.agent });
}

async function runWithRetries<S>(spec: CliAgentSpec<S>, prompt: string, ctx: NodeContext): Promise<string> {
  const retries = spec.retries ?? 2;
  let delay = spec.retryDelayMs ?? 3000;
  for (let attempt = 0; ; attempt++) {
    try {
      return EXCLUSIVE.has(spec.agent)
        ? await exclusive(spec.agent, () => runCli(spec, prompt, ctx))
        : await runCli(spec, prompt, ctx);
    } catch (error) {
      if (error instanceof UsageLimitError && !ctx.signal?.aborted) {
        await waitForReset(spec.agent, error, ctx);
        attempt--;
        continue;
      }
      const retryable = error instanceof CliAgentError && !(error instanceof CliNotFoundError);
      if (!retryable || ctx.signal?.aborted || attempt >= retries) throw error;
      ctx.emit({
        type: "log",
        node: ctx.node,
        message: `${spec.agent} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay / 1000}s: ${error.message}`,
      });
      await sleep(delay, undefined, { signal: ctx.signal });
      delay *= 2;
    }
  }
}

class CliNotFoundError extends CliAgentError {}

export class UsageLimitError extends CliAgentError {
  constructor(message: string, readonly resetAt?: Date) {
    super(message);
  }
}

const LIMIT_IN_ERROR =
  /usage limit|rate limit|(session|weekly|daily|5-hour|hourly) limit|limit (reached|exceeded|hit)|quota (exceeded|reached)|too many requests|out of (credits|usage)|\b429\b/i;
const LIMIT_IN_REPLY = /usage limit|limit (reached|exceeded|hit)|out of (credits|usage)/i;

const limitPollMs = () => Number(process.env.GRAPHWORK_LIMIT_POLL_MS ?? 30 * 60_000);

export function parseResetTime(text: string, now = new Date()): Date | undefined {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const iso = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso && !Number.isNaN(Date.parse(iso[0]))) return new Date(iso[0]);

  const rel = text.match(/\b(?:in|after)\s+(?=\d)(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?)?(?:\s*(\d+)\s*s(?:ec(?:ond)?s?)?)?/i);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms = (Number(rel[1] ?? 0) * 3600 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)) * 1000;
    return new Date(now.getTime() + ms);
  }

  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let hour = Number(clock[1]) % 24;
    const pm = clock[3]?.toLowerCase();
    if (pm === "pm" && hour < 12) hour += 12;
    if (pm === "am" && hour === 12) hour = 0;
    const at = new Date(now);
    at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    return at;
  }
  return undefined;
}

async function waitForReset(agent: CliAgent, error: UsageLimitError, ctx: NodeContext) {
  const now = Date.now();
  const known = error.resetAt && error.resetAt.getTime() > now;
  const until = known ? error.resetAt!.getTime() + 60_000 : now + limitPollMs();
  const time = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  ctx.emit({
    type: "log",
    node: ctx.node,
    message: `${agent} usage limit reached; paused until ${time}${known ? " (when it resets)" : " (then checks again)"}. Progress is saved.`,
  });
  await sleep(until - now, undefined, { signal: ctx.signal });
}

const SANDBOX_SETTINGS = {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    network: { allowLocalBinding: true },
  },
};

const queues = new Map<string, Promise<unknown>>();

function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

async function mockReply<S>(spec: CliAgentSpec<S>, state: Readonly<S>, prompt: string, ctx: NodeContext) {
  const delay = Number(process.env.GRAPHWORK_MOCK_DELAY_MS ?? 0);
  if (delay > 0) await sleep(delay, undefined, { signal: ctx.signal });
  return spec.mock?.(state) ?? `[mock ${spec.agent}] ${prompt.slice(0, 60)}…`;
}

async function runCli<S>(spec: CliAgentSpec<S>, prompt: string, ctx: NodeContext): Promise<string> {
  const cwd = spec.cwd ?? process.cwd();
  const command = spec.command ?? DEFAULT_COMMAND[spec.agent];
  const edit = spec.canEdit ?? false;

  switch (spec.agent) {
    case "claude": {
      const args = [
        "-p", prompt, "--output-format", "text",
        ...(spec.subagent ? ["--agent", spec.subagent] : []),
        ...(edit ? ["--permission-mode", "acceptEdits"] : []),
        ...(spec.canRunCommands || spec.sandboxCommands ? ["--allowedTools", "Bash"] : []),
      ];
      if (!spec.sandboxCommands) return exec(command, args, cwd, spec, ctx);
      const dir = await mkdtemp(path.join(tmpdir(), "graphwork-claude-"));
      try {
        const settings = path.join(dir, "settings.json");
        await writeFile(settings, JSON.stringify(SANDBOX_SETTINGS));
        return await exec(command, [...args, "--settings", settings], cwd, spec, ctx);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    case "cursor":
      return exec(command, ["-p", prompt, "--output-format", "text", ...(edit ? ["--force"] : []), ...(spec.trustWorkspace ? ["--trust"] : [])], cwd, spec, ctx);

    case "codex": {
      const dir = await mkdtemp(path.join(tmpdir(), "graphwork-codex-"));
      const out = path.join(dir, "last-message.txt");
      try {
        await exec(
          command,
          ["exec", "--skip-git-repo-check", "--sandbox", edit ? "workspace-write" : "read-only", "-C", cwd, "-o", out, prompt],
          cwd,
          spec,
          ctx,
        );
        return (await readFile(out, "utf8")).trim();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
}

function exec<S>(command: string, args: string[], cwd: string, spec: CliAgentSpec<S>, ctx: NodeContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, timeout: spec.timeoutMs ?? 600_000, maxBuffer: 32 * 1024 * 1024, signal: ctx.signal },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new CliNotFoundError(`"${command}" not found. Install the ${spec.agent} CLI (see README).`));
        } else if (error && ctx.signal?.aborted) {
          reject(error);
        } else if (error) {
          const how = error.killed ? "was killed (timeout?)" : `exited with code ${error.code ?? "?"}`;
          const detail = (stderr.trim() || stdout.trim()).slice(-800);
          const message = `${command} ${how}${detail ? `: ${detail}` : " and printed nothing"}`;
          reject(LIMIT_IN_ERROR.test(detail) ? new UsageLimitError(message, parseResetTime(detail)) : new CliAgentError(message));
        } else if (stdout.trim().length < 400 && LIMIT_IN_REPLY.test(stdout)) {
          reject(new UsageLimitError(`${command}: ${stdout.trim()}`, parseResetTime(stdout)));
        } else {
          resolve(stdout.trim());
        }
      },
    );
    child.stdin?.end();
  });
}
