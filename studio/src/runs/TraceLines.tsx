import type { ReactNode } from 'react';
import type { Trace } from '../../../core/src/store.ts';
import { Markdown } from '../Markdown.tsx';
import { accent, cx, Disclosure } from '../ui.tsx';
import { Io, Took } from './bits.tsx';
import { Raw } from './render/core.tsx';
import { ToolBody, toolName, toolSummary } from './render/tools.tsx';
import { detail, say, type Session } from './trace.ts';

export const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const short = (text: string, max = 140) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};
/** A trace line's raw JSON. */
const RawLine = ({ line }: { line: Trace }) => (
  <Disclosure summary={<span className="text-[11px] text-zinc-500">raw</span>} className="mt-1">
    <Raw value={line} />
  </Disclosure>
);

/** One trace line folded to a summary; open, it shows `children` and the raw line. */
const Row = ({ line, summary, children }: { line: Trace; summary: ReactNode; children?: ReactNode }) => (
  <li>
    <Disclosure
      summary={
        <span className="flex min-w-0 gap-2">
          <span className="shrink-0 text-zinc-400 tabular-nums">
            {new Date(line.at).toLocaleTimeString([], { hour12: false })}
          </span>
          <span className="min-w-0 truncate">{summary}</span>
        </span>
      }
    >
      <div className="space-y-2 py-1 pl-5">
        {children}
        <RawLine line={line} />
      </div>
    </Disclosure>
  </li>
);

const Pre = ({ text }: { text: string }) => (
  <pre className="max-h-[32rem] overflow-auto rounded bg-zinc-50 p-2 text-[11px] whitespace-pre-wrap dark:bg-zinc-900">
    {text}
  </pre>
);

const EventRow = ({ line }: { line: Extract<Trace, { event: unknown }> }) => {
  const e = line.event;
  if (e.type === 'tool')
    return (
      <Row
        line={line}
        summary={
          <>
            <span className="font-medium">{toolName(e.name)}</span> {toolSummary(e.name, e.input)}
            {e.denied && <span className={accent.text}> denied</span>}
            {e.ok === false && !e.denied && <span className={accent.text}> failed</span>}
            {e.exit !== undefined && <span className="text-zinc-500"> exit {e.exit}</span>}
          </>
        }
      >
        <ToolBody tool={e.name} input={e.input} output={e.output} ok={e.ok} />
      </Row>
    );
  if (e.type === 'text')
    return (
      <Row line={line} summary={<span className="text-zinc-600 dark:text-zinc-300">{short(e.text)}</span>}>
        <Markdown text={e.text} />
      </Row>
    );
  if (e.type === 'usage')
    return (
      <Row
        line={line}
        summary={
          <span className="text-zinc-500">
            usage {e.input.toLocaleString()} in, {e.output.toLocaleString()} out
            {e.usd !== undefined && `, ${usd(e.usd)}`}
          </span>
        }
      />
    );
  if (e.type === 'start')
    return (
      <Row
        line={line}
        summary={
          <span className="text-zinc-500">
            start {e.session}, model {e.model}
          </span>
        }
      />
    );
  return (
    <Row
      line={line}
      summary={
        <span className="text-zinc-500">
          end {e.ended}, exit {e.exit}
        </span>
      }
    >
      <Markdown text={e.final} />
    </Row>
  );
};

/** A session folded to who ran, how it ended and what it cost; open, its brief and every event in order. */
export const SessionBlock = ({ session, running }: { session: Session; running: boolean }) => {
  const { brief, events, end } = session;
  const spec = brief?.brief;
  const tools = events.filter(e => e.event.type === 'tool').length;
  const tally = { in: 0, out: 0, cached: 0, reasoning: 0 };
  for (const { event: e } of events)
    if (e.type === 'usage') Object.assign(tally, { in: tally.in + e.input, out: tally.out + e.output });
  const first = brief ?? events[0] ?? end;
  const started = events.find(e => e.event.type === 'start')?.event;
  const id = end?.session.id ?? spec?.resume?.id ?? (started?.type === 'start' ? started.session : undefined);
  return (
    <li className="rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800">
      <Disclosure
        open={running && !end}
        summary={
          <span className="flex min-w-0 flex-wrap gap-x-2">
            <span className="font-medium">{spec ? spec.bot : 'session'}</span>
            {spec && (
              <span className="text-zinc-500">
                {spec.harness}
                {spec.model && `, ${spec.model}`}
              </span>
            )}
            {id && <span className="text-zinc-500">{id}</span>}
            {(spec?.resume || end?.session.resumed) && <span className="text-zinc-500">resumed</span>}
            {brief?.item && <span className="truncate text-zinc-500">on {short(brief.item, 60)}</span>}
            <span className="text-zinc-500">{tools} tool calls</span>
            <Io tally={tally} />
            {end ? (
              <span className={cx(end.session.ended === 'stop' ? 'text-zinc-500' : accent.text)}>
                ended {end.session.ended}
                {end.session.exit !== undefined && `, exit ${end.session.exit}`}, {usd(end.session.usd)}
              </span>
            ) : (
              <span className={accent.text}>{running ? 'running' : 'no end recorded'}</span>
            )}
            {first && <Took startedAt={first.at} endedAt={end?.at} />}
          </span>
        }
      >
        <ol className="space-y-0.5 py-1 font-mono text-[11px]">
          {brief ? (
            <Row line={brief} summary={<span className="font-medium">brief</span>}>
              <div className="font-sans text-xs text-zinc-500">
                tools: {brief.brief.tools.length ? brief.brief.tools.join(', ') : 'none'}, dir {brief.brief.dir},{' '}
                {brief.brief.minutes} minutes
              </div>
              <Disclosure summary={<span className="font-sans text-xs">system prompt</span>}>
                <Markdown text={brief.brief.system} className="font-sans" />
              </Disclosure>
              <Markdown text={brief.brief.prompt} className="font-sans" />
            </Row>
          ) : (
            <li className="font-sans text-xs text-zinc-500">
              No brief in this trace; it was recorded before briefs were.
            </li>
          )}
          {events.map((line, i) => (
            <EventRow key={i} line={line} />
          ))}
          {end && (
            <Row
              line={end}
              summary={
                <span className="text-zinc-500">
                  session {end.session.id ?? ''} ended {end.session.ended}
                </span>
              }
            />
          )}
        </ol>
      </Disclosure>
    </li>
  );
};

/** A verdict, an applied proposal or an outcome. */
export const LineRow = ({ line }: { line: Trace }) => {
  if ('verdict' in line) {
    const v = line.verdict;
    return (
      <Row
        line={line}
        summary={
          <>
            <span className={cx(!v.pass && accent.text)}>
              {v.check} {v.pass ? 'passed' : 'failed'}
            </span>
            <span className="text-zinc-500">
              {line.item && ` on ${short(line.item, 60)}`}, {v.ms} ms{line.exit !== undefined && `, exit ${line.exit}`}
            </span>
          </>
        }
      >
        {line.item && <Pre text={line.item} />}
        {v.findings && <Pre text={v.findings} />}
      </Row>
    );
  }
  if ('applied' in line) {
    const { proposal: p, ok, url, reason } = line.applied;
    return (
      <Row
        line={line}
        summary={
          <>
            <span className={cx(!ok && accent.text)}>
              {p.kind} {ok ? 'applied' : `failed: ${reason}`}
            </span>
            {url && <span className="text-zinc-500"> {url.replace('https://github.com/', '')}</span>}
          </>
        }
      >
        {url && (
          <a className="text-sky-600 underline" href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
        )}
        {'body' in p && <Markdown text={p.body} className="font-sans" />}
      </Row>
    );
  }
  if ('outcome' in line) {
    const o = line.outcome;
    return (
      <Row
        line={line}
        summary={
          <>
            <span className="font-medium">{o.kind}</span>
            <span className="text-zinc-500">
              {' '}
              then {line.run.step}, {line.run.status}, try {line.run.tries}
            </span>
            {detail(o) && <span className="text-zinc-500">: {short(detail(o))}</span>}
          </>
        }
      >
        {detail(o) && <Pre text={detail(o)} />}
      </Row>
    );
  }
  if ('saved' in line)
    return (
      <Row
        line={line}
        summary={
          <span className="text-zinc-500">
            run.json{' '}
            {Object.entries(line.saved)
              .map(([k, v]) => `${k} ${short(typeof v === 'string' ? v : JSON.stringify(v), 60)}`)
              .join(', ')}
            {line.cleared && `, cleared ${line.cleared.join(', ')}`}
          </span>
        }
      />
    );
  return <Row line={line} summary={say(line)} />;
};
