import { useAtomValue, useSetAtom } from 'jotai';
import { Suspense, use, useEffect, useRef } from 'react';
import { Markdown } from '../Markdown.tsx';
import { infoAtom } from '../state.ts';
import { Link } from '../ui.tsx';
import { DiffFiles, DiffSummary, useOpenFiles, WhitespaceToggle } from './DiffView.tsx';
import { live } from './live.ts';
import { fetchPullDiff, hideWhitespaceAtom, type PullListing, pullsAtom, pullsQueryAtom } from './pulls.ts';
import { PullReview } from './Review.tsx';

/** Keeps the merge request list fresh as `pulls.jsonl` and the runs change. */
const useFreshPulls = () => {
  const refresh = useSetAtom(pullsQueryAtom);
  const pulls = useAtomValue(live.pulls);
  const rows = useAtomValue(live.rows);
  const signature = `${pulls.map(p => `${p.number}:${p.state}`).join()}|${rows?.length ?? 0}`;
  const last = useRef(signature);
  useEffect(() => {
    if (last.current === signature) return;
    last.current = signature;
    refresh();
  }, [signature, refresh]);
};

const Branches = ({ pull }: { pull: Pick<PullListing, 'branch' | 'into'> }) => (
  <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
    {pull.branch} into {pull.into}
  </span>
);

const Mergeable = ({ pull }: { pull: PullListing }) =>
  pull.state === 'open' && pull.mergeable !== undefined ? (
    <span className="shrink-0 text-xs text-zinc-500">{pull.mergeable ? 'mergeable' : 'conflicts'}</span>
  ) : null;

const Crumbs = ({ pull }: { pull?: boolean }) => (
  <span className="flex items-center gap-2 text-xs text-zinc-500">
    <Link href="/runs" className="hover:text-zinc-900 dark:hover:text-zinc-100">
      Runs
    </Link>
    /
    {pull ? (
      <Link href="/pulls" className="hover:text-zinc-900 dark:hover:text-zinc-100">
        Merge requests
      </Link>
    ) : (
      <span className="font-medium text-zinc-900 dark:text-zinc-100">Merge requests</span>
    )}
  </span>
);

const PullList = ({ pulls }: { pulls: PullListing[] }) => {
  const info = useAtomValue(infoAtom);
  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <Crumbs />
      </div>
      {pulls.length ? (
        <ul>
          {pulls.map(pull => (
            <li
              key={pull.number}
              className="relative flex items-center gap-2 border-b border-zinc-100 px-3 py-1.5 text-xs hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/50"
            >
              <span className="w-8 shrink-0 text-zinc-500 tabular-nums">#{pull.number}</span>
              <Link
                href={`/pulls/${pull.number}`}
                className="truncate text-sm font-medium after:absolute after:inset-0 hover:underline"
              >
                {pull.title}
              </Link>
              <Branches pull={pull} />
              <span className="ml-auto shrink-0 text-zinc-500">{pull.state}</span>
              <Mergeable pull={pull} />
              {pull.files && <DiffSummary files={pull.files} />}
            </li>
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

const PullDiff = ({ pull, hide }: { pull: PullListing; hide: boolean }) => {
  const open = useOpenFiles();
  const diff = use(fetchPullDiff(pull.number, pull.head, hide));
  const refresh = useSetAtom(pullsQueryAtom);
  return (
    <PullReview pull={pull} onSent={refresh}>
      {diff ? (
        <DiffFiles files={diff.files} hiddenFiles={diff.hiddenFiles} open={open} />
      ) : (
        <p className="text-xs text-zinc-500">The diff could not be read.</p>
      )}
    </PullReview>
  );
};

const PullPage = ({ pull }: { pull: PullListing }) => {
  const hide = useAtomValue(hideWhitespaceAtom);
  return (
    <div className="h-full overflow-y-auto">
      <header className="space-y-1 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <Crumbs pull />
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <span className="min-w-0 truncate">{pull.title}</span>
          <span className="shrink-0 font-normal text-zinc-500">#{pull.number}</span>
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-zinc-500">{pull.state}</span>
          <Branches pull={pull} />
          <Mergeable pull={pull} />
          {pull.files && <DiffSummary files={pull.files} />}
          {pull.run && (
            <Link href={`/runs/${encodeURIComponent(pull.run)}`} className="text-zinc-500 hover:underline">
              the run that opened it
            </Link>
          )}
          <WhitespaceToggle />
        </div>
      </header>
      <div className="max-w-5xl space-y-3 px-4 py-3">
        {pull.body.trim() && (
          <div className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <Markdown text={pull.body} />
          </div>
        )}
        <Suspense fallback={null}>
          <PullDiff pull={pull} hide={hide} />
        </Suspense>
      </div>
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
        <Link href="/pulls" className="underline">
          All merge requests
        </Link>
      </div>
    );
  return <PullPage key={pull.number} pull={pull} />;
};
