import { useAtomValue, useSetAtom } from 'jotai';
import { type ReactNode, Suspense, use, useEffect, useMemo, useRef } from 'react';
import type { RunRow } from '../../../src/live.ts';
import type { Tone } from '../graph-model.ts';
import { Markdown } from '../Markdown.tsx';
import { Link } from '../Providers.tsx';
import { infoAtom } from '../state.ts';
import { Icon } from '../studio/icons.tsx';
import { cx, tones, Tooltip } from '../ui.tsx';
import { age, StatusIcon } from './bits.tsx';
import { Counts, DiffFiles, DiffSummary, fileAnchor, useOpenFiles, WhitespaceToggle } from './DiffView.tsx';
import { live } from './live.ts';
import { fetchPullDiff, hideWhitespaceAtom, type PullListing, pullsAtom, pullsQueryAtom } from './pulls.ts';
import { PullReview } from './Review.tsx';

const stateTones: Record<PullListing['state'], Tone> = { open: 'ok', merged: 'info', closed: 'neutral' };
const stateTips: Record<PullListing['state'], string> = {
  open: 'Open merge request',
  merged: 'Merged',
  closed: 'Closed without merging',
};

/** A merge request's state as its one icon, in the state's tone. */
const PullIcon = ({ state, className = 'size-3.5' }: { state: PullListing['state']; className?: string }) => (
  <Tooltip tip={stateTips[state]}>
    <span role="img" aria-label={state} className={cx('inline-flex shrink-0', tones[stateTones[state]].text)}>
      <Icon name="pull" className={className} />
    </span>
  </Tooltip>
);

const Mergeable = ({ pull }: { pull: PullListing }) =>
  pull.state === 'open' && pull.mergeable !== undefined ? (
    <Tooltip
      tip={
        pull.mergeable
          ? `${pull.branch} merges into ${pull.into} without conflicts`
          : `${pull.branch} conflicts with ${pull.into}; the merge needs the conflicts resolved first`
      }
    >
      <span className={cx('shrink-0 text-xs', pull.mergeable ? tones.ok.text : tones.warn.text)}>
        {pull.mergeable ? 'mergeable' : 'conflicts'}
      </span>
    </Tooltip>
  ) : null;

const Branches = ({ pull }: { pull: Pick<PullListing, 'branch' | 'into'> }) => (
  <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-zinc-500">
    <span className="truncate">{pull.branch}</span>
    <Icon name="right" className="size-2.5 text-zinc-400" />
    <span className="truncate">{pull.into}</span>
  </span>
);

const runLabel = (run: RunRow | undefined, pull: PullListing) =>
  run
    ? `${run.check ?? run.job}${run.event.number === undefined ? '' : ` on #${run.event.number}`}`
    : pull.origin
      ? pull.origin.job
      : undefined;

/** Keeps the merge request list fresh as `pulls.jsonl` and the runs change. */
const useFreshPulls = () => {
  const refresh = useSetAtom(pullsQueryAtom);
  const pulls = useAtomValue(live.pulls);
  const rows = useAtomValue(live.rows);
  const signature = `${pulls.map(p => `${p.number}:${p.state}`).join()}|${rows?.map(r => `${r.id}:${r.status}`).join() ?? ''}`;
  const last = useRef(signature);
  useEffect(() => {
    if (last.current === signature) return;
    last.current = signature;
    refresh();
  }, [signature, refresh]);
};

const PullLine = ({ pull, run }: { pull: PullListing; run: RunRow | undefined }) => {
  const label = runLabel(run, pull);
  return (
    <li className="relative flex items-center gap-2 border-b border-zinc-100 px-3 py-1.5 text-xs hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900">
      <PullIcon state={pull.state} />
      <span className="w-6 shrink-0 text-zinc-500 tabular-nums">#{pull.number}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Link
          href={`/dashboard/pulls/${pull.number}`}
          className="truncate text-sm font-medium after:absolute after:inset-0 hover:underline"
        >
          {pull.title}
        </Link>
        <Branches pull={pull} />
      </span>
      <Mergeable pull={pull} />
      {pull.files && <DiffSummary files={pull.files} />}
      {label && (
        <span className="relative z-10 w-40 shrink-0 truncate text-right">
          {pull.run ? (
            <Tooltip tip="The run that opened this merge request" action="Open the run">
              <Link href={`/dashboard/runs/${encodeURIComponent(pull.run)}`} className="text-zinc-500 hover:underline">
                {label}
              </Link>
            </Tooltip>
          ) : (
            <span className="text-zinc-500">{label}</span>
          )}
        </span>
      )}
    </li>
  );
};

const PullList = ({ pulls }: { pulls: PullListing[] }) => {
  const rows = useAtomValue(live.rows);
  const info = useAtomValue(infoAtom);
  const byId = useMemo(() => new Map(rows?.map(r => [r.id, r])), [rows]);
  const open = pulls.filter(p => p.state === 'open').length;
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
        <Link href="/dashboard" className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          Runs
        </Link>
        <span aria-hidden className="text-zinc-300 select-none dark:text-zinc-600">
          /
        </span>
        <span className="font-medium">Changes</span>
        <span className="text-zinc-500 tabular-nums">
          {open} open, {pulls.length - open} closed or merged
        </span>
      </div>
      {pulls.length ? (
        <ul>
          {pulls.map(pull => (
            <PullLine key={pull.number} pull={pull} run={pull.run ? byId.get(pull.run) : undefined} />
          ))}
        </ul>
      ) : (
        <p className="p-4 text-sm text-zinc-500">
          No merge requests in{' '}
          {info ? <code className="font-mono">{info.dataReal ?? info.data}</code> : 'this data directory'} yet.
        </p>
      )}
    </div>
  );
};

/** Runs about the same work: on the issue the request came from, and on the request itself. */
const relatedRuns = (rows: RunRow[], pull: PullListing) =>
  rows
    .filter(r =>
      r.event.trigger === 'pull_request'
        ? r.event.number === pull.number
        : pull.issue !== undefined && r.event.number === pull.issue
    )
    .toSorted((a, b) => (a.id < b.id ? -1 : 1));

const RunLinks = ({ pull }: { pull: PullListing }) => {
  const rows = useAtomValue(live.rows);
  const related = useMemo(() => (rows ? relatedRuns(rows, pull) : []), [rows, pull]);
  if (!related.length) return null;
  const runs = related.filter(r => !r.check);
  const checks = related.filter(r => r.check);
  const failed = checks.filter(r => r.status === 'failed' || r.status === 'timed-out').length;
  return (
    <section className="space-y-1">
      <h3 className="px-1 text-xs font-medium text-zinc-500">Runs</h3>
      <ul>
        {runs.map(run => (
          <li key={run.id}>
            <Link
              href={`/dashboard/runs/${encodeURIComponent(run.id)}`}
              className={cx(
                'flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900',
                run.id === pull.run && 'font-medium'
              )}
            >
              <StatusIcon status={run.status} level="job" className="size-3" />
              <span className="min-w-0 flex-1 truncate">
                {run.job}
                {(run.attempt ?? 1) > 1 && <span className="text-zinc-500"> {run.attempt}</span>}
              </span>
              <span className="shrink-0 text-zinc-500">{age(run.startedAt ?? run.event.ts)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {checks.length > 0 && (
        <Tooltip tip={[...new Set(checks.map(r => r.check))].join(', ')}>
          <p className="px-1 text-xs text-zinc-500 tabular-nums">
            {checks.length} {checks.length === 1 ? 'check' : 'checks'}
            {failed > 0 && <span className={tones.danger.text}>, {failed} failed</span>}
          </p>
        </Tooltip>
      )}
    </section>
  );
};

/** The changed files grouped by folder, each with its counts; clicking one opens and scrolls to it. */
const FileTree = ({ files, onPick }: { files: NonNullable<PullListing['files']>; onPick: (path: string) => void }) => {
  const folders = useMemo(() => {
    const byFolder = new Map<string, typeof files>();
    for (const file of files) {
      const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
    }
    return [...byFolder];
  }, [files]);
  return (
    <section className="space-y-1">
      <h3 className="px-1 text-xs font-medium text-zinc-500">Files</h3>
      <ul className="space-y-1">
        {folders.map(([folder, list]) => (
          <li key={folder}>
            {folder && <div className="truncate px-1 font-mono text-[11px] text-zinc-500">{folder}/</div>}
            <ul>
              {list.map(file => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => onPick(file.path)}
                    className={cx(
                      'flex w-full items-center gap-2 rounded py-0.5 pr-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900',
                      folder ? 'pl-3' : 'pl-1'
                    )}
                  >
                    <span
                      className={cx(
                        'min-w-0 flex-1 truncate font-mono text-[11px]',
                        file.status === 'deleted' && 'line-through'
                      )}
                    >
                      {file.path.slice(folder ? folder.length + 1 : 0)}
                    </span>
                    <Counts additions={file.additions} deletions={file.deletions} className="text-[10px]" />
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
};

type OpenFiles = ReturnType<typeof useOpenFiles>;

/** The side column and the body, with the diff below the body once it has arrived. */
const PullColumns = ({
  pull,
  files,
  open,
  children,
}: {
  pull: PullListing;
  files: NonNullable<PullListing['files']> | undefined;
  open: OpenFiles;
  children?: ReactNode;
}) => {
  const pick = (path: string) => {
    open.set(path, true);
    requestAnimationFrame(() => document.getElementById(fileAnchor(path))?.closest('details')?.scrollIntoView());
  };
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <aside className="sticky top-3 hidden max-h-[calc(100dvh-6rem)] w-64 shrink-0 space-y-4 overflow-y-auto md:block">
        {files && <FileTree files={files} onPick={pick} />}
        <RunLinks pull={pull} />
      </aside>
      <div className="min-w-0 flex-1 space-y-3">
        {pull.body.trim() && (
          <div className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <Markdown text={pull.body} />
          </div>
        )}
        {children}
      </div>
    </div>
  );
};

const PullDiff = ({ pull, hide, open }: { pull: PullListing; hide: boolean; open: OpenFiles }) => {
  const diff = use(fetchPullDiff(pull.number, pull.head, hide));
  const refresh = useSetAtom(pullsQueryAtom);
  return (
    <PullColumns pull={pull} files={diff?.files ?? pull.files} open={open}>
      <PullReview pull={pull} onSent={refresh}>
        {diff ? (
          <DiffFiles files={diff.files} hiddenFiles={diff.hiddenFiles} open={open} />
        ) : (
          <p className="text-xs text-zinc-500">The diff could not be read.</p>
        )}
      </PullReview>
    </PullColumns>
  );
};

const PullPage = ({ pull }: { pull: PullListing }) => {
  const open = useOpenFiles();
  const hide = useAtomValue(hideWhitespaceAtom);
  const rows = useAtomValue(live.rows);
  const opener = pull.run ? rows?.find(r => r.id === pull.run) : undefined;
  const label = runLabel(opener, pull);
  return (
    <div className="h-full overflow-y-auto">
      <header className="space-y-1 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Link href="/dashboard" className="hover:text-zinc-900 dark:hover:text-zinc-100">
            Runs
          </Link>
          <span aria-hidden className="text-zinc-300 select-none dark:text-zinc-600">
            /
          </span>
          <Link href="/dashboard/pulls" className="hover:text-zinc-900 dark:hover:text-zinc-100">
            Changes
          </Link>
        </div>
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <PullIcon state={pull.state} className="size-4" />
          <span className="min-w-0 truncate">{pull.title}</span>
          <span className="shrink-0 font-normal text-zinc-500">#{pull.number}</span>
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={tones[stateTones[pull.state]].text}>{pull.state}</span>
          <Branches pull={pull} />
          <Mergeable pull={pull} />
          {pull.files && <DiffSummary files={pull.files} />}
          {label && pull.run && (
            <Tooltip tip="The run that opened this merge request" action="Open the run">
              <Link
                href={`/dashboard/runs/${encodeURIComponent(pull.run)}`}
                className="text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
              >
                opened by {label}
              </Link>
            </Tooltip>
          )}
          <WhitespaceToggle />
        </div>
      </header>
      <Suspense fallback={<PullColumns pull={pull} files={pull.files} open={open} />}>
        <PullDiff pull={pull} hide={hide} open={open} />
      </Suspense>
    </div>
  );
};

/** The merge requests bothub opened, or one of them with its diff when `number` is given. */
export const PullsView = ({ number }: { number: number | null }) => {
  useFreshPulls();
  const pulls = useAtomValue(pullsAtom);
  if (!pulls) return null;
  if (number === null) return <PullList pulls={pulls} />;
  const pull = pulls.find(p => p.number === number);
  if (!pull)
    return (
      <div className="space-y-2 p-4 text-sm text-zinc-500">
        <p>There is no merge request #{number}.</p>
        <Link href="/dashboard/pulls" className="underline">
          All merge requests
        </Link>
      </div>
    );
  return <PullPage key={pull.number} pull={pull} />;
};

/** Links to the merge requests, with how many are open. */
export const ChangesLink = () => {
  const pulls = useAtomValue(pullsAtom);
  const open = pulls?.filter(p => p.state === 'open').length ?? 0;
  return (
    <Tooltip tip="Merge requests bothub opened and the changes in them" action="List them">
      <Link
        href="/dashboard/pulls"
        className="inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900"
      >
        <Icon name="pull" className={cx('size-3.5', tones.ok.text)} />
        {pulls !== undefined && <span className="tabular-nums">{open}</span>}
        <span className="text-zinc-500">changes</span>
      </Link>
    </Tooltip>
  );
};
