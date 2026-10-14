import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "../../src/config.ts";
import { localIssues } from "../../src/issues-local.ts";
import { runPlanned, type Pipeline } from "../../src/pipeline.ts";
import { limiter, runJob, unsandboxed } from "../../src/runner.ts";
import { openStore } from "../../src/store.ts";
import type { AgentEvent, BotEvent, HarnessAdapter } from "../../src/types.ts";
import { workspaces } from "../../src/workspace.ts";
import { sourceRepo, temp } from "../kit.ts";
import { modelServer, type Step } from "./model-server.ts";

const answer = 'Done.\n```bothub\n[{"kind":"reply","body":"fixed"}]\n```';
const md = (path: string, front: string, body = "") => ({
  path,
  source: `---\n${front}\n---\n\n${body}`,
});
const compiled = compile([
  md(
    "bots/bot.md",
    "harness: opencode\ntools: [read]\nreturns: [reply]\nmax-turns: 7",
    "You are a bot.",
  ),
  md("skills/triage.md", "description: Sort.", "Triage."),
  md(
    "workflows/w.md",
    "on: { issue_comment: {} }\njobs:\n  triage: { type: bot, mode: warn, bot: bot, skill: triage, returns: [reply] }",
  ),
]);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
const { config } = compiled;
const event: BotEvent = {
  id: "d1",
  ts: "2026-10-12T00:00:00.000Z",
  source: "github",
  trigger: "issue_comment",
  action: "created",
  repo: "acme/app",
  number: 7,
  actor: { login: "octocat", association: "OWNER" },
  body: "look",
  url: "https://github.com/acme/app/issues/7#c1",
};

/** A minimal harness: one streamed completion from `BOTHUB_LLM_BASE_URL`, reported as agent events. */
const client = `const out = e => console.log(JSON.stringify(e));
const fail = m => { out({ type: 'error', message: m }); process.exit(1); };
(async () => {
  const r = await fetch(process.env.BOTHUB_LLM_BASE_URL + '/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.BOTHUB_LLM_API_KEY }, body: process.argv[1] });
  if (!r.ok) return fail('HTTP ' + r.status + ' ' + (await r.text()));
  let text = '', buf = '';
  for await (const part of r.body) {
    buf += Buffer.from(part); const lines = buf.split('\\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: {')) continue;
      const delta = JSON.parse(line.slice(6)).choices[0].delta;
      if (delta.content) out({ type: 'text', text: (text += delta.content) });
      for (const c of delta.tool_calls ?? []) out({ type: 'tool_call', id: c.id, tool: c.function.name, input: {} });
    }
  }
  out({ type: 'end', ok: true, result: text });
})().catch(e => fail(e.message));`;
const adapter: HarnessAdapter = {
  name: "opencode",
  command: (spec) => ({
    cmd: process.execPath,
    args: ["-e", client, spec.prompt],
    env: {},
  }),
  parseLine: (line) => (line.trim() ? [JSON.parse(line) as AgentEvent] : []),
};

const closers: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  closers.splice(0).forEach((close) => close());
});

/** Runs the triage job against a fake model playing `script`. */
const job = async (script: Step[], extra: Partial<Pipeline> = {}) => {
  const model = await modelServer(script);
  closers.push(model.close);
  const dir = temp("chaos");
  const issueDir = temp("chaos-issues");
  writeFileSync(
    join(issueDir, "7-task.md"),
    "---\ntitle: Task\n---\n\nDo it.\n",
  );
  const alerts: string[] = [];
  const p: Pipeline = {
    config,
    event,
    store: openStore(dir),
    workspaces: workspaces({ dataDir: dir, cloneUrl: () => sourceRepo().dir }),
    limit: await Effect.runPromise(limiter(1)),
    env: { BOTHUB_LLM_API_KEY: "key", BOTHUB_LLM_BASE_URL: model.url },
    adapters: { opencode: adapter, pi: adapter, claude: adapter },
    launch: unsandboxed,
    issues: localIssues(issueDir, { repo: "acme/app" }),
    stallMinutes: 0.01,
    onAlert: (line) => alerts.push(line),
    ...extra,
  };
  const { run } = await Effect.runPromise(
    runPlanned({ workflow: "w", job: "triage", bot: "bot" }, p),
  );
  return { run, model, alerts };
};

/** Runs the 10 second retry wait of an agent that died early on a fast clock. */
const fastClock = () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const tick = setInterval(() => vi.advanceTimersByTime(1000), 5);
  closers.push(() => clearInterval(tick));
};

describe("chaos: the fake model server", () => {
  it("plays a script per request and repeats the last step", async () => {
    const model = await modelServer([
      { status: 429, retryAfter: 2 },
      { tool: "read" },
    ]);
    closers.push(model.close);
    const [a, b, c] = await Promise.all(
      [1, 2, 3].map(async () =>
        fetch(`${model.url}/chat/completions`, { method: "POST", body: "{}" }),
      ),
    );
    expect([a!.status, b!.status, c!.status].sort()).toEqual([200, 200, 429]);
    expect(model.seen).toHaveLength(3);
  });
});

describe("chaos: recovery from model faults", () => {
  it("completes a healthy run", async () => {
    const { run, model } = await job([{ say: answer }]);
    expect(run).toMatchObject({ status: "succeeded", closure: "done" });
    expect(model.seen).toHaveLength(1);
  });

  it("does not stall on a slow stream that keeps sending", async () => {
    const { run } = await job([{ slow: 120, say: answer }]);
    expect(run).toMatchObject({ status: "succeeded", closure: "done" });
  });

  it("retries after a 503 and finishes the job", async () => {
    fastClock();
    const { run, model } = await job([{ status: 503 }, { say: answer }], {
      stallMinutes: 10,
    });
    expect(model.seen).toHaveLength(2);
    expect(run).toMatchObject({ status: "succeeded", closure: "done" });
  });

  it.fails(
    "alerts a human once a 500 outlasts the retries, and defers instead of blocking",
    async () => {
      fastClock();
      const { run, alerts } = await job([{ status: 500 }], {
        stallMinutes: 10,
      });
      expect(run).toMatchObject({ stopped: "infra", closure: "deferred" });
      expect(alerts).toHaveLength(1);
    },
  );

  it.fails(
    "defers on an auth error without retrying, and alerts at once",
    async () => {
      const { run, model, alerts } = await job([
        { status: 401 },
        { say: answer },
      ]);
      expect(model.seen).toHaveLength(1);
      expect(run).toMatchObject({ stopped: "infra", closure: "deferred" });
      expect(alerts).toHaveLength(1);
    },
  );

  it.fails(
    "waits out a 429 with Retry-After and finishes the job",
    async () => {
      const { run, model } = await job([
        { status: 429, retryAfter: 1 },
        { say: answer },
      ]);
      expect(model.seen).toHaveLength(2);
      expect(run).toMatchObject({ status: "succeeded", closure: "done" });
    },
  );

  it.fails(
    "retries a model that never answers, instead of closing blocked",
    async () => {
      const { run, model } = await job([{ hang: true }, { say: answer }]);
      expect(run.closure).not.toBe("blocked");
      expect(model.seen).toHaveLength(2);
    },
  );

  it.fails(
    "retries a stream that stalls after a few chunks, instead of closing blocked",
    async () => {
      const { run, model } = await job([{ stall: 3 }, { say: answer }]);
      expect(run.closure).not.toBe("blocked");
      expect(model.seen).toHaveLength(2);
    },
  );

  it.fails(
    "retries a stream whose socket closes midway, instead of closing blocked",
    async () => {
      const { run, model } = await job([{ drop: 3 }, { say: answer }]);
      expect(run.closure).not.toBe("blocked");
      expect(model.seen).toHaveLength(2);
    },
  );
});

describe("chaos: the stall watchdog", () => {
  const noisy = (tool: boolean): HarnessAdapter => ({
    ...adapter,
    command: () => ({
      cmd: process.execPath,
      args: [
        "-e",
        `const o = e => console.log(JSON.stringify(e));
        ${tool ? `o({ type: 'tool_call', id: 't', tool: 'bash', input: { command: 'sleep 999' } });` : ""}
        setInterval(() => o({ type: 'usage', inputTokens: 1, outputTokens: 0 }), 50);`,
      ],
      env: {},
    }),
  });
  const run = async (tool: boolean) => {
    const store = openStore(temp("chaos-stall"));
    const { id } = await store.create({
      workflow: "w",
      job: "j",
      harness: "opencode",
      event,
    });
    return Effect.runPromise(
      runJob({
        adapter: noisy(tool),
        spec: {
          prompt: "p",
          system: "s",
          cwd: temp("cwd"),
          tools: [],
          maxTurns: 1,
        },
        timeoutMinutes: 0.03,
        stallMinutes: 0.01,
        store,
        runId: id,
        launch: unsandboxed,
      }),
    );
  };

  it("does not stop a harness that keeps emitting events", async () => {
    expect(await run(false)).toMatchObject({ stopped: "timeout" });
  });

  it.fails(
    "stops a tool call that never returns while other events keep flowing",
    async () => {
      expect(await run(true)).toMatchObject({ stopped: "stalled" });
    },
  );
});
