import { Schema } from 'effect';
import { useAtomValue } from 'jotai';
import { createContext, type ReactNode, useContext, useState } from 'react';
import type { Proposal } from '../../../src/proposal.ts';
import { Pulse } from '../icons.tsx';
import { Code, Markdown } from '../Markdown.tsx';
import { RunResultBadge, RunResultLines } from '../results/ResultTable.tsx';
import { dataParam, makeInstanceHref, runAction, runAtom, runResultsAtom, shown } from '../state.ts';
import { accent, Badge, cx, Disclosure, Link, Live, Tooltip } from '../ui.tsx';
import { Raw, ToolBody, toolName, toolSummary } from './tools.tsx';
import {
  atLink,
  type ServedRun,
  detail,
  formatCheckValue,
  graphLink,
  makeRunKey,
  type Line,
  type TraceLineWithKey,
  type SessionTraceLines,
  splitTraceIntoVisitedSteps,
} from './trace.ts';
import type { sumSpend } from '../../../src/stats.ts';
import { formatReason, type Exit, type RunRecord, Trace } from '../../../src/types.ts';

/** One row of a run: a summary line, and what opens under it: a body, child rows and the JSON it came from. */
export type Row = {
  key?: string;
  at?: string | undefined;
  summary: ReactNode;
  body?: ReactNode;
  children?: Row[];
  raw?: unknown;
  open?: boolean;
  scroll?: boolean;
  /** The line a deep link points at, highlighted. */
  target?: boolean;
};

const usd = ({ usd: n = 0, unpriced }: Parameters<typeof sumSpend>[0][number]) =>
  `${n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`}${unpriced === undefined ? '' : '+'}`;
const formatLimitTip = ({ label }: NonNullable<ServedRun['run']['limits']>['usdPerRun']) =>
  label ? `usd-per-run from ${label.name}, added by ${label.actor}` : 'usd-per-run from settings.yaml';
const used = (u: Exit['used']) =>
  u
    ? `, ${Math.round(u.peak / 2 ** 20)} MB peak, ${(u.cpu / 1000).toFixed(1)} s cpu${u.oom ? ', out of memory' : ''}`
    : '';
const tokens = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`;
const short = (text: string, max = 140) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};
/** Numbers cut to 4 decimals, trailing zeros dropped. */
const round = (_: string, v: unknown) => (typeof v === 'number' ? Number(v.toFixed(4)) : v);
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });
const took = (from: string, to: string | undefined) => {
  if (!to) return `since ${clock(from)}`;
  const s = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000);
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
};
const muted = (text: ReactNode) => <span className="text-zinc-500">{text}</span>;
const flag = (text: ReactNode, on = true) => <span className={cx(on && accent.text)}>{text}</span>;
const Pre = ({ text }: { text: string }) => <Code code={text} compact wrap lines={16} />;
const Url = ({ url, text }: { url: string; text?: string }) =>
  /^https?:\/\//.test(url) ? (
    <a className="text-sky-600 underline" href={url} target="_blank" rel="noreferrer">
      {text ?? url.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\//, '')}
    </a>
  ) : (
    <span className="text-zinc-500">{url}</span>
  );

const RunInstance = createContext<string | undefined>(undefined);

/** Copies the full URL of a studio page. */
const CopyLink = ({ href, instance }: { href: string; instance: string | undefined }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-zinc-400 underline hover:text-zinc-900 dark:hover:text-zinc-100"
      onClick={() =>
        navigator.clipboard.writeText(new URL(makeInstanceHref(href, instance), location.origin).href).then(
          () => setCopied(true),
          () => undefined
        )
      }
    >
      {copied ? 'copied' : 'copy link'}
    </button>
  );
};

const readJudgeSessions = (text: string): Row[] | undefined => {
  try {
    const lines = text
      .trim()
      .split('\n')
      .map(l => Schema.decodeUnknownSync(Schema.fromJsonString(Trace))(l));
    if (!lines.every(l => 'prompt' in l || 'event' in l || 'session' in l)) return;
    return splitTraceIntoVisitedSteps(lines).flatMap(v =>
      v.parts.map(part => ('events' in part ? sessionRow(part, false, false) : lineRow(part)))
    );
  } catch {
    return;
  }
};

/** A check's full output or its judge sessions, fetched from the data dir when asked for. */
const FullLog = ({ log }: { log: NonNullable<TraceLineWithKey<'check'>['log']> }) => {
  const [text, setText] = useState<string>();
  const data = useAtomValue(dataParam);
  const instance = useContext(RunInstance);
  if (text !== undefined) {
    const sessions = readJudgeSessions(text);
    return sessions ? <Rows rows={sessions} /> : <Pre text={text} />;
  }
  return (
    <button
      type="button"
      className="font-sans text-[10px] text-sky-600 underline"
      onClick={() =>
        runAction(actions => actions.log({ hash: log.hash }), data, instance).then(
          text => setText(text ?? 'not in the data dir'),
          (e: Error) => setText(e.message)
        )
      }
    >
      full log, {log.bytes.toLocaleString()} bytes
    </button>
  );
};

/** Where the text under it came from. */
const From = ({ children }: { children: ReactNode }) => (
  <div className="font-sans text-[10px] text-zinc-500">{children}</div>
);

type Event = TraceLineWithKey<'event'>['event'];

const kindName = (kind: string) => (kind === 'pull_request' ? 'pull' : kind);

/** A proposal in a few words: the labels it changes, the text it posts or the title it opens. */
const gist = (p: Proposal) =>
  p.kind === 'label'
    ? [...(p.add ?? []).map(l => `+${l}`), ...(p.remove ?? []).map(l => `-${l}`)].join(' ')
    : 'title' in p
      ? p.title
      : 'body' in p
        ? p.body
        : 'question' in p
          ? p.question
          : 'why' in p
            ? p.why
            : 'message' in p
              ? p.message
              : p.kind === 'merge'
                ? `#${p.number}`
                : '';

const tips = {
  line: {
    session: 'One agent session: its prompt, then every event in order. Open it for the details.',
    aside: 'A fork of an earlier session that answers a comment in its thread while the run keeps waiting.',
    prompt: 'What the agent was given: its system file, the task and the tools it may use.',
    text: 'Text the agent wrote during the session.',
    thinking: 'What the agent reasoned before acting, as its harness reports it.',
    tool: 'A tool the agent called. Open it for the input and the result.',
    check: 'A check the engine ran on the try. A failing check that blocks sends the try back.',
    saved:
      "The engine saved the run's state to its run.json: the fields that changed, like step, status, tries or cost.",
    spoken: 'What a person said that started this run, from a comment or the command line.',
    told: 'A message the router passed on to this run. The run reads it on its next look.',
  },
  proposal: {
    comment: 'A comment agentgraph posted, under the thread a human last spoke in.',
    label: 'Labels agentgraph added to or removed from the issue.',
    push: 'Commits agentgraph pushed to the run branch.',
    pull: 'A pull request agentgraph opened.',
    merge: 'A pull request agentgraph merged.',
    issue: 'An issue agentgraph filed: a part, a follow-up or a graph change.',
    ask: 'A question agentgraph posted. The run waits for your answer.',
    back: 'The agent sent the run back to an earlier step.',
    run: 'Another workflow this run started by name.',
    react: 'A reaction agentgraph left on a comment to show it saw it.',
    rebase: 'agentgraph moved the branch onto its new base.',
  },
  outcome: {
    pass: 'The step finished and its checks passed. The run moves on.',
    failed: 'The try failed: a check that blocks failed or a proposal was invalid. The step tries again.',
    back: 'The step sent the run back to an earlier step, with the reason below.',
    ask: 'The step stopped to ask a human. The run waits for an answer.',
    answer: 'A human answered, so the step goes on with that answer.',
    stop: 'The run stopped here, with the reason below.',
  },
} as const;

/** A row's kind as a pill that says on hover what it means. */
const Pill = ({ of, kind }: { of: keyof typeof tips; kind: string }) => {
  const tip = (tips[of] as Record<string, string>)[kind];
  return tip ? (
    <Tooltip tip={tip}>
      <Badge>{kind}</Badge>
    </Tooltip>
  ) : (
    <Badge>{kind}</Badge>
  );
};

const events: { [T in Event['type']]: (e: Extract<Event, { type: T }>) => Row } = {
  tool: e => ({
    summary: (
      <>
        <Tooltip tip={tips.line.tool}>
          <Badge>{toolName(e.name)}</Badge>
        </Tooltip>{' '}
        {toolSummary(e.name, e.input)}
        {e.denied && muted(' denied')}
        {e.ok === false && !e.denied && muted(' failed')}
        {e.exit !== undefined && muted(` exit ${e.exit}`)}
      </>
    ),
    body: <ToolBody tool={e.name} input={e.input} output={e.output} ok={e.ok} />,
  }),
  text: e => ({
    summary: (
      <>
        <Pill of="line" kind="text" /> {short(e.text)}
      </>
    ),
    body: (
      <>
        <From>session text</From>
        <Markdown text={e.text} className="agi-tight" />
      </>
    ),
  }),
  thinking: e => ({
    summary: (
      <>
        <Pill of="line" kind="thinking" /> {muted(short(e.text))}
      </>
    ),
    body: (
      <>
        <From>session thinking</From>
        <Markdown text={e.text} className="agi-tight" />
      </>
    ),
  }),
  usage: e => ({
    summary: muted(
      `usage ${e.input.toLocaleString()} in, ${e.output.toLocaleString()} out${e.unpriced !== undefined ? `, ${e.unpriced} unpriced` : e.usd === undefined ? '' : `, ${usd(e)}`}`
    ),
  }),
  start: e => ({ summary: muted(`start ${e.session}, model ${e.model}`) }),
  end: e => ({
    summary: muted(`end ${e.ended}, exit ${e.exit}`),
    body: (
      <>
        <From>final reply</From>
        <Markdown text={e.final} className="agi-tight" />
      </>
    ),
  }),
};

/** How each kind of trace line reads as a row. */
const lines: {
  [
    K in
      | 'prompt'
      | 'event'
      | 'session'
      | 'check'
      | 'applied'
      | 'outcome'
      | 'saved'
      | 'spoken'
      | 'told'
      | 'setup'
      | 'cache'
      | 'env'
  ]: (l: TraceLineWithKey<K>, by: string) => Row;
} = {
  prompt: ({ prompt: p }) => ({
    summary: (
      <>
        <Pill of="line" kind="prompt" /> {muted(`to ${p.agent}, ${p.tools.length} tools, ${p.minutes} minutes`)}
      </>
    ),
    body: (
      <div className="space-y-2 font-sans">
        {muted(`tools ${p.tools.length ? p.tools.join(', ') : 'none'}, dir ${p.dir}`)}
        <Disclosure summary={<span className="text-xs">system prompt, the agent's file</span>}>
          <Markdown text={p.system} className="agi-tight" />
        </Disclosure>
        <From>prompt agentgraph wrote from the step, the issue and its comments</From>
        <Markdown text={p.prompt} className="agi-tight" />
      </div>
    ),
  }),
  event: ({ event }) => (events[event.type] as (e: Event) => Row)(event),
  session: ({ session: s }) => ({
    summary: muted(`session ${s.id ?? ''} ended ${s.ended}, ${usd(s)}${used(s.used)}`),
  }),
  check: line => ({
    summary: (
      <>
        <Pill of="line" kind="check" /> {line.check.check}{' '}
        {line.check.na ? muted('n/a') : line.check.empty ? muted('skipped') : line.check.pass ? 'pass' : muted('fail')}
        {formatCheckValue(line.check) && ` ${formatCheckValue(line.check)}`}
        {muted(
          `${line.later ? ', checked later' : ''}${line.item ? ` on ${short(line.item, 60)}` : ''}, ${line.check.ms} ms${line.usd > 0 || line.unpriced !== undefined ? `, ${usd(line)}` : ''}${line.exit === undefined ? '' : `, exit ${line.exit}`}${used(line.used)}`
        )}
      </>
    ),
    body: (line.item || line.check.findings || line.log) && (
      <>
        {line.item && <From>item</From>}
        {line.item && <Pre text={line.item} />}
        {line.check.findings && <From>check output</From>}
        {line.check.findings && <Pre text={line.check.findings} />}
        {line.log && <FullLog log={line.log} />}
      </>
    ),
  }),
  applied: ({ applied: { proposal: p, ok, url, reason } }, by) => ({
    summary: (
      <>
        <Pill of="proposal" kind={kindName(p.kind)} /> {muted(by)} {short(gist(p), 120)}
        {!ok && flag(` failed: ${short(reason ?? '', 120)}`)} {url && <Url url={url} />}
      </>
    ),
    body: ('body' in p || 'question' in p) && (
      <div className="space-y-1 py-0.5 pl-4">
        {'title' in p && <p className="font-medium">{p.title}</p>}
        {'body' in p && <Markdown text={p.body} className="agi-tight" />}
        {'question' in p && <Markdown text={p.question} className="agi-tight" />}
        {url && p.kind === 'pull_request' && <Url url={`${url}/files`} text="the diff on GitHub" />}
      </div>
    ),
  }),
  outcome: line => ({
    summary: (
      <>
        <Pill of="outcome" kind={line.outcome.kind} />
        {muted(` then ${line.run.step}, ${line.run.status}, try ${line.run.tries}`)}
        {detail(line.outcome) && muted(`: ${short(detail(line.outcome))}`)}
      </>
    ),
    body: detail(line.outcome) && (
      <p className="max-w-4xl py-0.5 pl-4 break-words whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
        {detail(line.outcome)}
      </p>
    ),
  }),
  saved: line => ({
    summary: (
      <>
        <Pill of="line" kind="saved" />{' '}
        {muted(
          [
            ...Object.entries(line.saved).map(
              ([k, v]) => `${k} ${short(typeof v === 'string' ? v : JSON.stringify(v, round), 60)}`
            ),
            ...(line.cleared ?? []).map(k => `cleared ${k}`),
          ].join(', ')
        )}
      </>
    ),
  }),
  spoken: ({ spoken: s }) => ({
    summary: (
      <>
        <Pill of="line" kind="spoken" /> {muted(`${s.actor}: ${short(s.comment?.body ?? s.kind, 120)}`)}
      </>
    ),
  }),
  setup: ({ setup: s }) => ({ summary: muted(`setup exited ${s.exit} in ${s.ms} ms${used(s.used)}`) }),
  cache: ({ cache: c }) => ({ summary: muted(`cache, ${c.files} files`) }),
  env: ({ env: e }) => ({ summary: muted(`env ${e.mode} ${e.key}${e.match ? '' : ', inputs changed'}`) }),
  told: ({ told: t }) => ({
    summary: (
      <>
        <Pill of="line" kind="told" /> {muted(`from ${t.by}: ${short(t.text, 120)}`)}
      </>
    ),
  }),
};

/** A trace line as a row, read through `lines`; `by` is who proposed what it applied. */
const lineRow = (line: Line, by = 'agentgraph'): Row => {
  const kind = (Object.keys(lines) as (keyof typeof lines)[]).find(k => k in line);
  if (!kind) return { at: line.at, raw: line, summary: muted(short(JSON.stringify(line), 120)) };
  return { at: line.at, raw: line, ...(lines[kind] as (l: Line, by: string) => Row)(line, by) };
};

/** A session folded to who ran, on what, how it ended and what it cost, its end line as its raw; open, its prompt and every event in order. */
const sessionRow = (
  { prompt, events, end }: SessionTraceLines,
  running: boolean,
  expand: boolean,
  repo?: string,
  target?: Line
): Row => {
  const spec = prompt?.prompt;
  const aside = prompt?.aside;
  const heard =
    repo && aside?.issue !== undefined && aside.comment !== undefined
      ? `https://github.com/${repo}/issues/${aside.issue}#${aside.review ? 'discussion_r' : 'issuecomment-'}${aside.comment}`
      : undefined;
  const started = events.find((e): e is typeof e & { event: { type: 'start' } } => e.event.type === 'start')?.event;
  const id = end?.session.id ?? spec?.resume?.id ?? started?.session;
  const usage = events.flatMap(e => (e.event.type === 'usage' ? [e.event] : []));
  const first = (prompt ?? events[0])?.at;
  const how =
    end &&
    `${end.session.ended}${end.session.exit === undefined ? '' : `, exit ${end.session.exit}`}${used(end.session.used)}`;
  return {
    at: first ?? end?.at,
    open: expand || (running && !end) || [prompt, ...events, end].some(l => l && l === target),
    scroll: true,
    raw: end,
    summary: (
      <span className="flex min-w-0 items-baseline gap-x-2">
        <Pill of="line" kind={aside || end?.session.aside ? 'aside' : 'session'} />
        {spec && <span className="font-medium">{spec.agent}</span>}
        {heard && <Url url={heard} text="the comment" />}
        {started && muted([started.harness, started.provider, started.model].filter(Boolean).join(', '))}
        {spec?.check && muted(`judges ${spec.check}`)}
        {prompt?.item && muted(`on ${short(prompt.item, 60)}`)}
        {id && muted(id)}
        {(spec?.resume || end?.session.resumed) && muted('resumed')}
        {end?.session.dropped && muted(`resume dropped: ${short(end.session.dropped, 80)}`)}
        {events.length > 0 && muted(`${events.filter(e => e.event.type === 'tool').length} tool calls`)}
        {usage.length > 0 &&
          muted(
            `${tokens(usage.reduce((n, u) => n + u.input, 0))} in, ${tokens(usage.reduce((n, u) => n + u.output, 0))} out`
          )}
        {end
          ? events.length
            ? flag(`ended ${how}, ${usd(end.session)}`, end.session.ended !== 'stop')
            : flag(`ended before it started: ${how}`)
          : flag(running ? 'running' : 'no end recorded')}
        {first && muted(took(first, end?.at))}
      </span>
    ),
    children: [...(prompt ? [prompt] : []), ...events].map(line => ({
      ...lineRow(line),
      ...(line === target && { target: true }),
    })),
    ...(end && end === target && { target: true }),
  };
};

/** What a run is doing or waiting for, in a sentence or two. */
export const statusTip = (
  run: Pick<RunRecord, 'said' | 'issue' | 'status' | 'step' | 'tries' | 'reason' | 'waiting'>
) => {
  const at = `issue #${run.said?.[0]?.issue ?? run.issue}`;
  if (run.status === 'running') return `Working on ${run.step}, try ${run.tries + 1}.`;
  if (run.status === 'done') return 'Finished every step.';
  if (run.status === 'stopped') return `Ended early${run.reason ? `: ${run.reason}` : ''}.`;
  if (run.waiting) return formatReason(run);
  if (run.reason !== undefined)
    return `Asked on ${at}: ${short(run.reason, 300)}\nWaits for an answer: say /agent and the answer there. /agent:stop ends the run.`;
  return `Waits at ${run.step} for a human, not the bot.\nMerge or approve the pull request to move on; say /agent or request changes to send it back; /agent:stop ends the run.`;
};

/** A fixed-width cell of a run row, so numbers line up down the list. */
const Col = ({ className, children }: { className: string; children: ReactNode }) => (
  <span className={cx('shrink-0 truncate tabular-nums', className)}>{children}</span>
);

/** A run's issue as a link to it on the tracker. */
const Issue = ({ r }: { r: ServedRun }) =>
  r.run.issue === undefined ? null : r.repo ? (
    <Url url={`https://github.com/${r.repo}/issues/${r.run.issue}`} text={`#${r.run.issue}`} />
  ) : (
    <>#{r.run.issue}</>
  );

const useRunResults = (r: ServedRun) => {
  const { value } = useAtomValue(runResultsAtom(r.data, r.instance));
  const run = value?.runs.find(x => x.key === r.run.id);
  return value && run ? { run, fields: value.fields, place: r } : undefined;
};

const ResultBadge = ({ r }: { r: ServedRun }) => {
  const results = useRunResults(r);
  return results ? <RunResultBadge {...results} /> : null;
};

const FetchedRaw = ({ r }: { r: ServedRun }) => (
  <Live state={useAtomValue(runAtom(r.run.id, r.data, r.instance))}>{value => value && <Raw value={value.run} />}</Live>
);

/** An open run's first line: its try and its JSON, then why it stopped or what it asks. */
const RunInfo = ({ r }: { r: ServedRun }) => {
  const { run } = r;
  const [raw, setRaw] = useState(false);
  const results = useRunResults(r);
  return (
    <>
      <p className="flex gap-x-2 text-zinc-500">
        <span>try {run.tries}</span>
        <button type="button" aria-pressed={raw} className="underline" onClick={() => setRaw(!raw)}>
          raw
        </button>
      </p>
      {raw && (r.trace ? <Raw value={run} /> : <FetchedRaw r={r} />)}
      {results && <RunResultLines {...results} />}
      {formatReason(run) && (
        <p className="max-w-4xl py-0.5 pl-4 break-words whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
          {formatReason(run)}
        </p>
      )}
      {!r.trace && <Visits r={r} />}
    </>
  );
};

/** A run on one line that opens it on the Runs page. */
export const RunLine = ({ r }: { r: ServedRun }) => (
  <Link
    href={atLink(r.run.id, undefined, r.data)}
    instance={r.instance}
    className="flex min-w-0 items-baseline gap-x-2 rounded px-1 py-0.5 font-mono transition-colors text-[11px] hover:bg-zinc-100 dark:hover:bg-zinc-800"
  >
    <Col className="w-[4ch]">{r.run.issue !== undefined && `#${r.run.issue}`}</Col>
    <Col className="w-[8ch]">{flag(r.run.status, r.run.status === 'running' || r.run.status === 'waiting')}</Col>
    <Col className="text-zinc-500">{took(r.run.started, undefined)}</Col>
  </Link>
);

const makeVisitRows = (r: ServedRun, trace: Line[], expand: boolean, target?: Line): Row[] => {
  const { run } = r;
  const visits = splitTraceIntoVisitedSteps(trace);
  let by: string | undefined;
  const partRow = (part: SessionTraceLines | Line): Row => {
    if ('events' in part) {
      by ??= part.prompt?.prompt.agent ?? 'the agent';
      return sessionRow(part, r.run.status === 'running', expand, r.repo, target);
    }
    const row = lineRow(part, by);
    if ('outcome' in part) by = undefined;
    return {
      ...row,
      ...(part === target && { target: true, open: true }),
      ...('applied' in part && {
        summary: (
          <>
            {row.summary} <CopyLink href={atLink(run.id, part.applied.at ?? part.at, r.data)} instance={r.instance} />
          </>
        ),
      }),
    };
  };
  return visits.map((visit, i) => {
    const checks = new Map(
      visit.parts.flatMap(part =>
        'check' in part && part.item === undefined ? [[part.check.check, part.check.pass] as const] : []
      )
    );
    const failed = [...checks].flatMap(([name, pass]) => (pass ? [] : [name]));
    return {
      open: true,
      summary: (
        <span className="flex min-w-0 items-baseline gap-x-2">
          <span className={cx('font-medium', r.run.status === 'running' && i === visits.length - 1 && accent.text)}>
            {visit.step}
          </span>
          {checks.size > 0 && muted(`${checks.size} checks${failed.length ? `, failed ${failed.join(', ')}` : ''}`)}
        </span>
      ),
      children: visit.parts.map(partRow),
    };
  });
};

const Visits = ({ r }: { r: ServedRun }) => (
  <Live state={useAtomValue(runAtom(r.run.id, r.data, r.instance))}>
    {value =>
      value?.trace ? (
        <RunInstance value={r.instance}>
          <Rows rows={makeVisitRows(value, value.trace, false)} />
        </RunInstance>
      ) : (
        <p className="text-zinc-500">No run {r.run.id}.</p>
      )
    }
  </Live>
);

/** A run as a row: where it stands, what it cost and left on the tracker; open, the steps it visited, read from its trace or fetched when it has none. */
export const runRow = (r: ServedRun, open = false, expand = false, target?: Line): Row => {
  const { run } = r;
  return {
    key: makeRunKey(r.instance, run.id),
    open,
    at: run.started,
    summary: (
      <span className="flex min-w-0 items-baseline gap-x-2 text-xs">
        {r.instance !== undefined && r.instance !== shown?.name && (
          <Link href={`/runs?instance=${encodeURIComponent(r.instance)}`} title="Runs of this instance">
            <Badge>{r.instance}</Badge>
          </Link>
        )}
        <Col className="w-[4ch]">
          <Issue r={r} />
        </Col>
        <Col className="w-[9ch]">
          <Link href={atLink(run.id, undefined, r.data)} instance={r.instance} className="font-medium underline">
            {run.workflow}
          </Link>
        </Col>
        <Col className="w-[10ch]">
          <Tooltip tip={statusTip(run)} focusable>
            {flag(run.status, run.status !== 'done')}
          </Tooltip>
          {r.run.status === 'running' && (
            <span className={cx('ml-1.5 align-middle', accent.text)}>
              <Pulse />
            </span>
          )}
        </Col>
        <Col className="w-[16ch] text-zinc-500">at {run.step}</Col>
        <Link href={graphLink(r, target?.step ?? run.step)} instance={r.instance} className="shrink-0 underline">
          graph
        </Link>
        <Col className="w-[13ch] text-right text-zinc-500">
          {run.limits ? (
            <Tooltip tip={formatLimitTip(run.limits.usdPerRun)}>
              {usd(r)} of ${run.limits.usdPerRun.value}
            </Tooltip>
          ) : (
            usd(r)
          )}
        </Col>
        <Col className="w-[8ch] text-right text-zinc-500">
          {took(run.started, r.run.status === 'running' ? undefined : (run.ended ?? r.lastAt))}
        </Col>
        <ResultBadge r={r} />
        {Object.entries(r.labels).map(([key, value]) =>
          r.data ? (
            <Badge key={key}>{`${key}=${value}`}</Badge>
          ) : (
            <Link key={key} href={`/runs?label=${encodeURIComponent(`${key}=${value}`)}`} title="Runs with this label">
              <Badge>{`${key}=${value}`}</Badge>
            </Link>
          )
        )}
        {r.pull && <Url url={r.pull} />}
        {r.branch &&
          (r.repo ? (
            <Url url={`https://github.com/${r.repo}/tree/${r.branch}`} text={r.branch} />
          ) : (
            <span className="text-zinc-500">{r.branch}</span>
          ))}
        {r.urls.map(url => (
          <Url key={url} url={url} />
        ))}
      </span>
    ),
    body: <RunInfo r={r} />,
    ...(r.trace && { children: makeVisitRows(r, r.trace, expand, target) }),
  };
};

const targeted = 'rounded bg-amber-100/70 dark:bg-amber-900/30';

const Head = ({ row, full = false, children }: { row: Row; full?: boolean; children?: ReactNode }) => (
  <span className="flex min-w-0 items-baseline gap-2">
    {row.at && <span className="shrink-0 text-zinc-400 tabular-nums">{clock(row.at)}</span>}
    <span className={cx('min-w-0', full ? 'break-words [&_*]:whitespace-normal' : 'truncate')}>{row.summary}</span>
    {children}
  </span>
);

/** A quiet button on a row's line, shown on hover, that opens the row and switches one of its views. */
const RowButton = ({ label, open, onClick }: { label: string; open: boolean; onClick: () => void }) => (
  <button
    type="button"
    aria-pressed={open}
    className="shrink-0 text-zinc-400 opacity-0 group-hover/row:opacity-100 hover:text-zinc-900 focus:opacity-100 aria-pressed:opacity-100 dark:hover:text-zinc-100"
    onClick={e => {
      e.preventDefault();
      const details = e.currentTarget.closest('details');
      if (details && !details.open) {
        details.open = true;
        if (open) return;
      }
      onClick();
    }}
  >
    {label}
  </button>
);

/** A row with nothing under it but its JSON; a line cut short opens to its full text on click. */
const LeafView = ({ row }: { row: Row }) => {
  const [raw, setRaw] = useState(false);
  const [full, setFull] = useState(false);
  const [cut, setCut] = useState(false);
  const cutOff = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>('.truncate')].some(t => t.scrollWidth > t.clientWidth);
  return (
    <li className={cx('pl-4.5', row.target && targeted)} data-target={row.target || undefined}>
      <span
        className={cx('group/row block', (cut || full) && 'cursor-pointer')}
        onMouseEnter={e => setCut(cutOff(e.currentTarget))}
        onClick={e => {
          if (e.target instanceof Element && e.target.closest('a, button')) return;
          if (full || cutOff(e.currentTarget)) setFull(!full);
        }}
      >
        <Head row={row} full={full}>
          {row.raw !== undefined && <RowButton label="raw" open={raw} onClick={() => setRaw(!raw)} />}
        </Head>
      </span>
      {raw && <Raw value={row.raw} />}
    </li>
  );
};

const RowView = ({ row }: { row: Row }) => {
  const [raw, setRaw] = useState(false);
  const only = !row.body && row.raw === undefined && row.children?.length === 1 ? row.children[0] : undefined;
  if (only)
    return (
      <RowView
        row={{
          ...only,
          at: row.at ?? only.at,
          summary: (
            <span className="flex min-w-0 items-baseline gap-x-2">
              {row.summary}
              {only.summary}
            </span>
          ),
        }}
      />
    );
  if (!row.body && !row.children?.length) return <LeafView row={row} />;
  return (
    <li className={cx(row.target && targeted)} data-target={row.target || undefined}>
      <Disclosure
        summary={
          <Head row={row}>
            {row.raw !== undefined && <RowButton label="raw" open={raw} onClick={() => setRaw(!raw)} />}
          </Head>
        }
        summaryClassName="group/row"
        open={row.open ?? false}
      >
        {raw && (
          <div className="pl-3">
            <Raw value={row.raw} />
          </div>
        )}
        <div
          data-scroll={row.scroll || undefined}
          className={cx('space-y-0.5 py-0.5 pl-3', row.scroll && 'max-h-[75vh] overflow-y-auto')}
        >
          {row.body}
          {row.children && <Rows rows={row.children} />}
        </div>
      </Disclosure>
    </li>
  );
};

/** Rows as a list where each opens to its body, its children and its raw JSON; a row with one child shows it in its own line. */
export const Rows = ({ rows }: { rows: Row[] }) => (
  <ol className="space-y-px font-mono text-[11px]">
    {rows.map((row, i) => (
      <RowView key={row.key ?? i} row={row} />
    ))}
  </ol>
);
