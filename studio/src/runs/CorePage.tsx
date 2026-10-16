import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import { served } from 'virtual:fixtures';
import { Code } from '../Markdown.tsx';
import { pageAtom } from '../state.ts';
import { accent, cx, Disclosure, Link, Muted, usePolling } from '../ui.tsx';
import { age, Took } from './bits.tsx';
import { type CoreRun, linksOf, visitsOf } from './trace.ts';
import { LineRow, SessionBlock, usd } from './TraceLines.tsx';

const live = (r: CoreRun['run']) => r.status === 'running';
const issueUrl = (r: CoreRun) => r.repo && `https://github.com/${r.repo}/issues/${r.run.thread}`;
const ended = (r: CoreRun) => (live(r.run) ? undefined : (r.run.ended ?? r.trace.at(-1)?.at));

/** Answers `path` as JSON, again every few seconds while `poll` holds. */
const useJson = <T,>(path: string, poll: (value: T) => boolean) => {
  const [value, setValue] = useState<T>();
  const [failure, setFailure] = useState<string>();
  const load = () =>
    void fetch(path)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${path} answered ${r.status}`))))
      .then(
        v => {
          setValue(v as T);
          setFailure(undefined);
        },
        (e: Error) => setFailure(e.message)
      );
  useEffect(load, [path]);
  usePolling(load, value === undefined || poll(value) ? 3000 : null);
  return { value, failure };
};

const Links = ({ r }: { r: CoreRun }) => (
  <span className="flex flex-wrap gap-2">
    {linksOf(r.trace)
      .filter(l => l.kind === 'pull' || l.kind === 'issue' || l.kind === 'merge')
      .map(l => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="text-sky-600 underline">
          {l.url.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\//, '')}
        </a>
      ))}
  </span>
);

const Issue = ({ r }: { r: CoreRun }) =>
  issueUrl(r) ? (
    <a href={issueUrl(r)} target="_blank" rel="noreferrer" className="text-sky-600 underline">
      #{r.run.thread}
    </a>
  ) : (
    <span>#{r.run.thread}</span>
  );

const status = (r: CoreRun['run']) => (
  <span className={cx(r.status === 'done' ? 'text-zinc-500' : accent.text)}>{r.status}</span>
);

const RunTable = () => {
  const { value: runs, failure } = useJson<CoreRun[]>('/core/runs', () => true);
  if (!runs) return <Muted>{failure ?? 'Loading runs.'}</Muted>;
  if (!runs.length) return <Muted>No core runs in this data dir.</Muted>;
  const sorted = [...runs].sort((a, b) => b.run.started.localeCompare(a.run.started));
  return (
    <table className="w-full text-left text-[13px]">
      <thead className="text-xs text-zinc-500">
        <tr>
          {['issue', 'workflow', 'step', 'status', 'cost', 'took', 'started', 'links'].map(h => (
            <th key={h} className="px-2 py-1 font-normal">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map(r => (
          <tr key={r.run.id} className="border-t border-zinc-100 dark:border-zinc-900">
            <td className="px-2 py-1">
              <Issue r={r} />
            </td>
            <td className="px-2 py-1">
              <Link href={`/core/${encodeURIComponent(r.run.id)}`} className="underline">
                {r.run.workflow}
              </Link>
            </td>
            <td className="px-2 py-1">{r.run.step}</td>
            <td className="px-2 py-1">{status(r.run)}</td>
            <td className="px-2 py-1 text-zinc-500 tabular-nums">{usd(r.run.usd)}</td>
            <td className="px-2 py-1">
              <Took startedAt={r.run.started} endedAt={ended(r)} />
            </td>
            <td className="px-2 py-1 text-zinc-500">{age(r.run.started)}</td>
            <td className="px-2 py-1">
              <Links r={r} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const RunPage = ({ id }: { id: string }) => {
  const { value: r, failure } = useJson<CoreRun | null>(
    `/core/runs/${encodeURIComponent(id)}`,
    v => !!v && live(v.run)
  );
  if (r === undefined) return <Muted>{failure ?? 'Loading the run.'}</Muted>;
  if (r === null) return <Muted>No run {id} in this data dir.</Muted>;
  const { run } = r;
  const visits = visitsOf(r.trace);
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <Link href="/core" className="text-zinc-500 underline">
            runs
          </Link>
          <span className="font-medium">
            {run.workflow} on <Issue r={r} />
          </span>
          {status(run)}
          <span className="text-zinc-500">
            at {run.step}, try {run.tries}
          </span>
          <span className="text-zinc-500 tabular-nums">{usd(run.usd)}</span>
          <Took startedAt={run.started} endedAt={ended(r)} />
          <Link href={`/graph?run=${encodeURIComponent(`${r.fixture}:${run.id}`)}`} className="text-zinc-500 underline">
            graph
          </Link>
          <Links r={r} />
        </div>
        {run.reason && <p className="max-w-3xl text-xs text-zinc-600 dark:text-zinc-400">{run.reason}</p>}
        <Disclosure summary={<span className="text-[11px] text-zinc-500">run.json</span>}>
          <Code code={JSON.stringify(run, null, 2)} lang="json" compact wrap />
        </Disclosure>
      </div>
      <ol className="space-y-3">
        {visits.map((visit, i) => (
          <li
            key={i}
            className={cx(
              'border-l-2 pl-3',
              live(run) && i === visits.length - 1 ? accent.border : 'border-zinc-200 dark:border-zinc-800'
            )}
          >
            <div className="mb-1 text-xs font-medium">{visit.step}</div>
            <ol className="space-y-1 font-mono text-[11px]">
              {visit.parts.map((part, j) =>
                'events' in part ? (
                  <SessionBlock key={j} session={part} running={live(run)} />
                ) : (
                  <LineRow key={j} line={part} />
                )
              )}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
};

/** Core's runs: the list at `/core`, one run's steps, sessions and trace lines at `/core/<id>`. */
export const CorePage = () => {
  const page = useAtomValue(pageAtom);
  const id = 'run' in page ? page.run : null;
  return (
    <div className="h-full space-y-3 overflow-y-auto p-4">
      {served && served.problems.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium">The hub does not load.</p>
          <ul className="list-disc pl-5 text-xs">
            {served.problems.map((p, i) => (
              <li key={i}>
                <span className="font-mono">{p.path}</span>: {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {id ? <RunPage id={id} /> : <RunTable />}
    </div>
  );
};
