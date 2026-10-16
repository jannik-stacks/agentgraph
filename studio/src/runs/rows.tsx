import type { ReactNode } from 'react';
import type { Run } from '../../../src/workflow.ts';
import type { Trace } from '../../../src/store.ts';
import { Pulse } from '../icons.tsx';
import { Code, Markdown } from '../Markdown.tsx';
import { accent, cx, Disclosure, Link, Tooltip } from '../ui.tsx';
import { ToolBody, toolName, toolSummary } from './tools.tsx';
import { type CoreRun, detail, type Session, visitsOf } from './trace.ts';

/** One row of a run: a summary line, and what opens under it: a body, child rows and the JSON it came from. */
export type Row = {
  at?: string | undefined;
  summary: ReactNode;
  body?: ReactNode;
  children?: Row[];
  raw?: unknown;
  open?: boolean;
};

const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const tokens = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`;
const short = (text: string, max = 140) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};
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
const Url = ({ url, text }: { url: string; text?: string }) => (
  <a className="text-sky-600 underline" href={url} target="_blank" rel="noreferrer">
    {text ?? url.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\//, '')}
  </a>
);

type Line<K extends string> = Extract<Trace, Record<K, unknown>>;
type Event = Line<'event'>['event'];

const events: { [T in Event['type']]: (e: Extract<Event, { type: T }>) => Row } = {
  tool: e => ({
    summary: (
      <>
        <span className="font-medium">{toolName(e.name)}</span> {toolSummary(e.name, e.input)}
        {e.denied && flag(' denied')}
        {e.ok === false && !e.denied && flag(' failed')}
        {e.exit !== undefined && muted(` exit ${e.exit}`)}
      </>
    ),
    body: <ToolBody tool={e.name} input={e.input} output={e.output} ok={e.ok} />,
  }),
  text: e => ({ summary: short(e.text), body: <Markdown text={e.text} className="font-sans" /> }),
  usage: e => ({
    summary: muted(
      `usage ${e.input.toLocaleString()} in, ${e.output.toLocaleString()} out${e.usd === undefined ? '' : `, ${usd(e.usd)}`}`
    ),
  }),
  start: e => ({ summary: muted(`start ${e.session}, model ${e.model}`) }),
  end: e => ({
    summary: muted(`end ${e.ended}, exit ${e.exit}`),
    body: <Markdown text={e.final} className="font-sans" />,
  }),
};

/** How each kind of trace line reads as a row. */
const lines: {
  [K in 'prompt' | 'event' | 'session' | 'check' | 'applied' | 'outcome' | 'saved']: (l: Line<K>) => Row;
} = {
  prompt: ({ prompt: p }) => ({
    summary: <span className="font-medium">prompt</span>,
    body: (
      <div className="space-y-2 font-sans">
        {muted(`tools ${p.tools.length ? p.tools.join(', ') : 'none'}, dir ${p.dir}, ${p.minutes} minutes`)}
        <Disclosure summary={<span className="text-xs">system prompt</span>}>
          <Markdown text={p.system} />
        </Disclosure>
        <Markdown text={p.prompt} />
      </div>
    ),
  }),
  event: ({ event }) => (events[event.type] as (e: Event) => Row)(event),
  session: ({ session: s }) => ({ summary: muted(`session ${s.id ?? ''} ended ${s.ended}, ${usd(s.usd)}`) }),
  check: line => ({
    summary: (
      <>
        {flag(`${line.check.check} ${line.check.pass ? 'passed' : 'failed'}`, !line.check.pass)}
        {muted(
          `${line.item ? ` on ${short(line.item, 60)}` : ''}, ${line.check.ms} ms${line.exit === undefined ? '' : `, exit ${line.exit}`}`
        )}
      </>
    ),
    body: (line.item || line.check.findings) && (
      <>
        {line.item && <Pre text={line.item} />}
        {line.check.findings && <Pre text={line.check.findings} />}
      </>
    ),
  }),
  applied: ({ applied: { proposal: p, ok, url, reason } }) => ({
    summary: (
      <>
        {flag(`${p.kind} ${ok ? 'applied' : `failed: ${short(reason ?? '', 120)}`}`, !ok)} {url && <Url url={url} />}
      </>
    ),
    body: (
      <div className="space-y-1 font-sans">
        {url && p.kind === 'pull_request' && <Url url={`${url}/files`} text="the diff on GitHub" />}
        {url && p.kind === 'push' && <Url url={url} text="the commit on GitHub" />}
        {'title' in p && <p className="font-medium">{p.title}</p>}
        {'body' in p && <Markdown text={p.body} />}
        {'question' in p && <Markdown text={p.question} />}
      </div>
    ),
  }),
  outcome: line => ({
    summary: (
      <>
        <span className="font-medium">{line.outcome.kind}</span>
        {muted(` then ${line.run.step}, ${line.run.status}, try ${line.run.tries}`)}
        {detail(line.outcome) && muted(`: ${short(detail(line.outcome))}`)}
      </>
    ),
    body: detail(line.outcome) && <Pre text={detail(line.outcome)} />,
  }),
  saved: line => ({
    summary: muted(
      `run.json ${[
        ...Object.entries(line.saved).map(
          ([k, v]) => `${k} ${short(typeof v === 'string' ? v : JSON.stringify(v), 60)}`
        ),
        ...(line.cleared ?? []).map(k => `cleared ${k}`),
      ].join(', ')}`
    ),
  }),
};

/** A trace line as a row, read through `lines`. */
export const lineRow = (line: Trace): Row => {
  const kind = (Object.keys(lines) as (keyof typeof lines)[]).find(k => k in line)!;
  return { at: line.at, raw: line, ...(lines[kind] as (l: Trace) => Row)(line) };
};

/** A session folded to who ran, how it ended and what it cost; open, its prompt and every event in order. */
const sessionRow = ({ prompt, events, end }: Session, running: boolean): Row => {
  const spec = prompt?.prompt;
  const started = events.find(e => e.event.type === 'start')?.event;
  const id = end?.session.id ?? spec?.resume?.id ?? (started?.type === 'start' ? started.session : undefined);
  const usage = events.flatMap(e => (e.event.type === 'usage' ? [e.event] : []));
  const first = (prompt ?? events[0])?.at;
  return {
    at: first ?? end?.at,
    open: running && !end,
    summary: (
      <span className="flex min-w-0 gap-x-2">
        <span className="font-medium">{spec?.agent ?? 'session'}</span>
        {spec && muted(`${spec.harness}${spec.model ? `, ${spec.model}` : ''}`)}
        {id && muted(id)}
        {(spec?.resume || end?.session.resumed) && muted('resumed')}
        {prompt?.item && muted(`on ${short(prompt.item, 60)}`)}
        {events.length > 0 && muted(`${events.filter(e => e.event.type === 'tool').length} tool calls`)}
        {usage.length > 0 &&
          muted(
            `${tokens(usage.reduce((n, u) => n + u.input, 0))} in, ${tokens(usage.reduce((n, u) => n + u.output, 0))} out`
          )}
        {end
          ? flag(
              `ended ${end.session.ended}${end.session.exit === undefined ? '' : `, exit ${end.session.exit}`}, ${usd(end.session.usd)}`,
              end.session.ended !== 'stop'
            )
          : flag(running ? 'running' : 'no end recorded')}
        {first && muted(took(first, end?.at))}
      </span>
    ),
    children: [...(prompt ? [prompt] : []), ...events, ...(end ? [end] : [])].map(lineRow),
  };
};

const live = (r: CoreRun) => r.run.status === 'running';

const statusTip = (run: Run) => {
  const at = `issue #${run.said?.issue ?? run.issue}`;
  if (run.status === 'running') return `Working on ${run.step}, try ${run.tries + 1}.`;
  if (run.status === 'done') return 'Finished every step.';
  if (run.status === 'stopped') return `Ended early${run.reason ? `: ${run.reason}` : ''}.`;
  if (run.reason !== undefined)
    return `Asked on ${at}: ${short(run.reason, 300)}\nWaits for an answer: comment there with the bot's command. Saying stop ends the run.`;
  return `Waits at ${run.step} for a human, not the bot.\nMerge or approve the pull request to move on; comment with the bot's command or request changes to send it back; saying stop ends the run.`;
};

/** A fixed-width cell of a run row, so numbers line up down the list. */
const Col = ({ className, children }: { className: string; children: ReactNode }) => (
  <span className={cx('shrink-0 truncate tabular-nums', className)}>{children}</span>
);

/** A run's issue as a link to it on the forge. */
const Issue = ({ r }: { r: CoreRun }) =>
  r.repo ? (
    <Url url={`https://github.com/${r.repo}/issues/${r.run.issue}`} text={`#${r.run.issue}`} />
  ) : (
    <>#{r.run.issue}</>
  );

/** A run as a row: where it stands, what it cost and left on the forge; open, the steps it visited. */
export const runRow = (r: CoreRun, open = false): Row => {
  const { run, trace } = r;
  const visits = visitsOf(trace);
  return {
    open,
    at: run.started,
    raw: run,
    summary: (
      <span className="flex min-w-0 items-baseline gap-x-3 font-sans text-[13px]">
        <Col className="w-9">
          <Issue r={r} />
        </Col>
        <Col className="w-14">
          <Link href={`/runs/${encodeURIComponent(run.id)}`} className="font-medium underline">
            {run.workflow}
          </Link>
        </Col>
        <Col className="w-20">
          <Tooltip tip={statusTip(run)} focusable>
            {flag(run.status, run.status !== 'done')}
          </Tooltip>
          {live(r) && (
            <span className={cx('ml-1.5 align-middle', accent.text)}>
              <Pulse />
            </span>
          )}
        </Col>
        <Col className="w-28 text-zinc-500">at {run.step}</Col>
        <Col className="w-12 text-zinc-500">try {run.tries}</Col>
        <Col className="w-14 text-right text-zinc-500">{usd(run.usd)}</Col>
        <Col className="w-24 text-right text-zinc-500">
          {took(run.started, live(r) ? undefined : (run.ended ?? trace.at(-1)?.at))}
        </Col>
        <Link href={`/graph?run=${encodeURIComponent(`${r.fixture}:${run.id}`)}`} className="text-zinc-500 underline">
          graph
        </Link>
        {trace.flatMap((line, i) =>
          'applied' in line &&
          line.applied.url &&
          ['pull_request', 'issue', 'merge'].includes(line.applied.proposal.kind)
            ? [<Url key={i} url={line.applied.url} />]
            : []
        )}
      </span>
    ),
    body: run.reason && <p className="max-w-3xl font-sans text-xs text-zinc-600 dark:text-zinc-400">{run.reason}</p>,
    children: visits.map((visit, i) => ({
      open: true,
      summary: (
        <span className={cx('font-medium', live(r) && i === visits.length - 1 && accent.text)}>{visit.step}</span>
      ),
      children: visit.parts.map(part => ('events' in part ? sessionRow(part, live(r)) : lineRow(part))),
    })),
  };
};

const RowView = ({ row }: { row: Row }) => {
  const head = (
    <span className="flex min-w-0 gap-2">
      {row.at && <span className="shrink-0 text-zinc-400 tabular-nums">{clock(row.at)}</span>}
      <span className="min-w-0 truncate">{row.summary}</span>
    </span>
  );
  if (!row.body && !row.children?.length && row.raw === undefined) return <li className="pl-4.5">{head}</li>;
  return (
    <li>
      <Disclosure summary={head} open={row.open ?? false}>
        <div className="space-y-1 py-1 pl-4.5">
          {row.body}
          {row.children && <Rows rows={row.children} />}
          {row.raw !== undefined && (
            <Disclosure summary={muted('raw')}>
              <Code code={JSON.stringify(row.raw, null, 2)} lang="json" compact wrap lines={12} />
            </Disclosure>
          )}
        </div>
      </Disclosure>
    </li>
  );
};

/** Rows as a list where each opens to its body, its children and its raw JSON. */
export const Rows = ({ rows }: { rows: Row[] }) => (
  <ol className="space-y-0.5 font-mono text-[11px]">
    {rows.map((row, i) => (
      <RowView key={i} row={row} />
    ))}
  </ol>
);
