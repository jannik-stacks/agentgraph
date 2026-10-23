import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { pageAtom, navigateAtom, queryParam, runsAtom } from '../state.ts';
import { Problems } from '../Problems.tsx';
import { Combobox, Loading, Muted } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';
import { RunPage } from './RunPage.tsx';
import { type ServedRun, isGitHubRef, locatedLink } from './trace.ts';
import type { Located } from '../../../src/store.ts';

const issueParam = queryParam('issue');
const ghParam = queryParam('gh');

/** Opens what a GitHub link or comment id names, as the server's `locate` finds it. */
const Locate = ({ gh }: { gh: string }) => {
  const navigate = useSetAtom(navigateAtom);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let current = true;
    fetch(`/api/locate?gh=${encodeURIComponent(gh)}`)
      .then(r => r.json() as Promise<Located | { error: string } | null>)
      .then(
        found => {
          if (!current) return;
          if (!found) setFailure(`No run wrote ${gh}.`);
          else if ('error' in found) setFailure(found.error);
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
const issuesOf = (runs: ServedRun[]) => {
  const byIssue = new Map<number, { workflows: Set<string>; title?: string | undefined; body?: string | undefined }>();
  for (const { run } of runs.toSorted((a, b) => a.run.started.localeCompare(b.run.started))) {
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

const RunList = () => {
  const gh = useAtomValue(ghParam);
  return gh ? <Locate gh={gh} /> : <Runs />;
};

const Runs = () => {
  const { value: runs, failure } = useAtomValue(runsAtom);
  const [issue, setIssue] = useAtom(issueParam);
  const navigate = useSetAtom(navigateAtom);
  const options = useMemo(() => issuesOf(runs ?? []), [runs]);
  if (!runs) return failure ? <Muted>{failure}</Muted> : <Loading />;
  if (!runs.length) return <Muted>No runs in this data dir.</Muted>;
  const shown = runs
    .filter(r => issue === null || String(r.run.issue) === issue)
    .toSorted((a, b) => b.run.started.localeCompare(a.run.started));
  return (
    <>
      <div
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
      </div>
      <Rows rows={shown.map(r => runRow(r))} />
    </>
  );
};

/** The served hub's runs as rows, at `/runs`; one run opened with every trace line at `/runs/<id>`. */
export const RunsPage = () => {
  const { id } = useAtomValue(pageAtom);
  return (
    <div className="flex h-full flex-col">
      <Problems />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{id ? <RunPage id={id} /> : <RunList />}</div>
    </div>
  );
};
