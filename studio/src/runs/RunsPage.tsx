import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { isOnIssue } from '../../../src/graph.ts';
import { findRunsWaitingOnPeople, formatNextSteps } from '../../../src/status.ts';
import { pageAtom, navigateAtom, queryParam, runsAtom, shown } from '../state.ts';
import { Problems } from '../Problems.tsx';
import { accent, Button, Combobox, KeyPicker, Live, makeHiddenKeysAtom, Loading, Muted } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';
import { RunPage } from './RunPage.tsx';
import { type ServedRun, isGitHubRef, locatedLink } from './trace.ts';
import type { Located } from '../../../src/store.ts';

const issueParam = queryParam('issue');
const labelParam = queryParam('label');
const hiddenLabelKeysAtom = makeHiddenKeysAtom('agentgraph.hiddenLabelKeys');
const ghParam = queryParam('gh');
const waitingParam = queryParam('waiting');
const flags = shown?.name ? ` --instance ${shown.name}` : '';

/** Opens what a GitHub link or comment id names, as the server's `locate` finds it. */
const Locate = ({ gh }: { gh: string }) => {
  const navigate = useSetAtom(navigateAtom);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let current = true;
    fetch(`/api/locate?gh=${encodeURIComponent(gh)}`)
      .then(r => r.json() as Promise<(Located & { instance: string }) | { error: string } | null>)
      .then(
        found => {
          if (!current) return;
          if (!found) setFailure(`No run wrote ${gh}.`);
          else if ('error' in found) setFailure(found.error);
          else if (found.instance !== (shown?.name ?? '')) location.replace(`/${found.instance}${locatedLink(found)}`);
          else navigate({ href: locatedLink(found), replace: true });
        },
        (e: Error) => current && setFailure(e.message)
      );
    return () => {
      current = false;
    };
  }, [gh, navigate]);
  return failure ? <Muted>{failure}</Muted> : <Loading />;
};

/** Each issue the runs worked on, newest first, as a filter option with its title and body, else its workflows. */
const splitRunsByIssue = (runs: ServedRun[]) => {
  const byIssue = new Map<number, { workflows: Set<string>; title?: string | undefined; body?: string | undefined }>();
  for (const { run } of runs.toSorted((a, b) => a.run.started.localeCompare(b.run.started))) {
    if (run.issue === undefined) continue;
    const seen = byIssue.get(run.issue) ?? { workflows: new Set() };
    byIssue.set(run.issue, {
      workflows: seen.workflows.add(run.workflow),
      title: run.title ?? seen.title,
      body: run.body ?? seen.body,
    });
  }
  return [...byIssue]
    .sort(([a], [b]) => b - a)
    .map(([issue, { workflows, title, body }]) => ({
      value: String(issue),
      label: `#${issue} ${title ?? [...workflows].join(', ')}`,
      ...(body !== undefined && { detail: body }),
    }));
};

const RunListLive = () => <Live state={useAtomValue(runsAtom)}>{runs => <Runs runs={runs} />}</Live>;

const RunList = () => {
  const gh = useAtomValue(ghParam);
  return gh ? <Locate gh={gh} /> : <RunListLive />;
};

const NextSteps = ({ run, repo }: { run: Parameters<typeof formatNextSteps>[0]; repo: string }) => (
  <pre className="py-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
    {[run.reason, ...formatNextSteps(run, shown?.local ? undefined : repo || '<owner>/<repo>', flags).slice(1)]
      .filter(Boolean)
      .join('\n')}
  </pre>
);

const Runs = ({ runs }: { runs: ServedRun[] }) => {
  const [issue, setIssue] = useAtom(issueParam);
  const [label, setLabel] = useAtom(labelParam);
  const [hidden, setHidden] = useAtom(hiddenLabelKeysAtom);
  const [onlyWaiting, setOnlyWaiting] = useAtom(waitingParam);
  const navigate = useSetAtom(navigateAtom);
  const options = useMemo(() => splitRunsByIssue(runs), [runs]);
  const labels = useMemo(
    () =>
      [...new Set(runs.flatMap(r => Object.entries(r.labels).map(([k, v]) => `${k}=${v}`)))]
        .toSorted()
        .map(pair => ({ value: pair, label: pair })),
    [runs]
  );
  const keys = useMemo(() => [...new Set(runs.flatMap(r => Object.keys(r.labels)))].toSorted(), [runs]);
  const waiting = useMemo(
    () => new Map(findRunsWaitingOnPeople(runs.map(r => r.run).filter(isOnIssue)).map(run => [run.id, run])),
    [runs]
  );
  if (!runs.length) return <Muted>No runs in this data dir.</Muted>;
  const listed = runs
    .filter(r => issue === null || String(r.run.issue) === issue)
    .filter(r => label === null || Object.entries(r.labels).some(([k, v]) => `${k}=${v}` === label))
    .filter(r => onlyWaiting === null || waiting.has(r.run.id))
    .toSorted((a, b) => b.run.started.localeCompare(a.run.started));
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-3"
        onPaste={e => {
          const text = e.clipboardData.getData('text').trim();
          if (!isGitHubRef(text)) return;
          e.preventDefault();
          navigate({ href: `/runs?gh=${encodeURIComponent(text)}` });
        }}
      >
        <Combobox
          label="Issue"
          placeholder="every issue, or paste a GitHub link"
          value={issue}
          options={options}
          onChange={setIssue}
        />
        {(waiting.size > 0 || onlyWaiting !== null) && (
          <Button
            aria-pressed={onlyWaiting !== null}
            className="aria-pressed:border-current aria-pressed:bg-zinc-100 dark:aria-pressed:bg-zinc-800"
            onClick={() => setOnlyWaiting(onlyWaiting === null ? 'you' : null)}
          >
            <span className={accent.text}>{`${waiting.size} ${waiting.size === 1 ? 'needs' : 'need'} you`}</span>
          </Button>
        )}
      </div>
      {labels.length > 0 && (
        <>
          <Combobox label="Label" placeholder="every label" value={label} options={labels} onChange={setLabel} />
          <KeyPicker label="Labels" keys={keys} hidden={hidden} onChange={setHidden} />
        </>
      )}
      {onlyWaiting !== null && !listed.length ? (
        <Muted>Nothing waits for you.</Muted>
      ) : (
        <Rows
          rows={listed.map(r => {
            const row = runRow({
              ...r,
              labels: Object.fromEntries(Object.entries(r.labels).filter(([k]) => !hidden.includes(k))),
            });
            const run = onlyWaiting === null ? undefined : waiting.get(r.run.id);
            return run ? { ...row, open: true, children: [], body: <NextSteps run={run} repo={r.repo} /> } : row;
          })}
        />
      )}
    </>
  );
};

/** The served graph's runs as rows, at `/runs`; one run opened with every trace line at `/runs/<id>`. */
export const RunsPage = () => {
  const { id } = useAtomValue(pageAtom);
  return (
    <div className="flex h-full flex-col">
      <Problems />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{id ? <RunPage id={id} /> : <RunList />}</div>
    </div>
  );
};
