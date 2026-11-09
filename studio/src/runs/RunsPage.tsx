import { atom, type ExtractAtomValue, useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { isOnIssue } from '../../../src/graph.ts';
import { findRunsWaitingOnPeople, formatInstanceFlags, formatNextSteps } from '../../../src/status.ts';
import { getRunsAtom, instances, locationAtom, pageAtom, navigateAtom, queryParam, shown } from '../state.ts';
import { Problems } from '../Problems.tsx';
import { accent, Button, Combobox, KeyPicker, makeHiddenKeysAtom, Loading, Muted, Select } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';
import { RunPage } from './RunPage.tsx';
import { type ServedRun, isGitHubRef, locatedLink, makeRunKey } from './trace.ts';
import type { Located } from '../../../src/store.ts';

const issueParam = queryParam('issue');
const labelParam = queryParam('label');
const hiddenLabelKeysAtom = makeHiddenKeysAtom('agentgraph.hiddenLabelKeys');
const ghParam = queryParam('gh');
const waitingParam = queryParam('waiting');
const instanceParam = queryParam('instance');

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

const RunListLive = ({ picked }: { picked: string | null }) => {
  const groups = useMemo(
    () =>
      atom(get =>
        (picked !== null ? [picked] : instances.length ? instances.map(one => one.name) : ['']).map(name => ({
          name,
          ...get(getRunsAtom(name)),
        }))
      ),
    [picked]
  );
  return <Runs groups={useAtomValue(groups)} picked={picked} />;
};

const RunList = () => {
  const gh = useAtomValue(ghParam);
  const picked = useAtomValue(instanceParam);
  if (gh) return <Locate gh={gh} />;
  if (picked !== null && !(shown ? picked === shown.name : instances.some(one => one.name === picked)))
    return <Muted>{`?instance=${picked} names no instance this page lists.`}</Muted>;
  return <RunListLive picked={shown?.name ?? picked} />;
};

const NextSteps = ({ run, r }: { run: Parameters<typeof formatNextSteps>[0]; r: ServedRun }) => {
  const local = (r.instance === undefined ? shown : instances.find(one => one.name === r.instance))?.local;
  const github = local ? undefined : r.repo || '<owner>/<repo>';
  return (
    <pre className="py-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
      {[run.reason, ...formatNextSteps(run, github, formatInstanceFlags(undefined, undefined, r.instance)).slice(1)]
        .filter(Boolean)
        .join('\n')}
    </pre>
  );
};

const InstanceFilter = ({ picked }: { picked: string | null }) => {
  const { query } = useAtomValue(locationAtom);
  const navigate = useSetAtom(navigateAtom);
  return (
    <Select
      label="Instance"
      value={picked ?? ''}
      options={[{ value: '', label: 'all instances' }, ...instances.map(({ name }) => ({ value: name, label: name }))]}
      onChange={name => {
        const next = new URLSearchParams(query);
        if (name) next.set('instance', name);
        else next.delete('instance');
        const href = next.size ? `/runs?${next}` : '/runs';
        if (shown) location.assign(href);
        else navigate({ href });
      }}
    />
  );
};

const Runs = ({
  groups,
  picked,
}: {
  groups: ({ name: string } & ExtractAtomValue<ReturnType<typeof getRunsAtom>>)[];
  picked: string | null;
}) => {
  const [issue, setIssue] = useAtom(issueParam);
  const [label, setLabel] = useAtom(labelParam);
  const [hidden, setHidden] = useAtom(hiddenLabelKeysAtom);
  const [onlyWaiting, setOnlyWaiting] = useAtom(waitingParam);
  const navigate = useSetAtom(navigateAtom);
  const runs = useMemo(() => groups.flatMap(g => g.value ?? []), [groups]);
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
    () =>
      new Map(
        groups.flatMap(g =>
          findRunsWaitingOnPeople((g.value ?? []).map(r => r.run).filter(isOnIssue)).map(run => [
            makeRunKey(g.name, run.id),
            run,
          ])
        )
      ),
    [groups]
  );
  const missing = groups.filter(g => g.value === undefined);
  if (missing.length && missing.length === groups.length && !groups.some(g => g.failure !== undefined))
    return <Loading />;
  if (!runs.length && !missing.length) return <Muted>No runs in this data dir.</Muted>;
  const listed = runs
    .filter(r => issue === null || String(r.run.issue) === issue)
    .filter(r => label === null || Object.entries(r.labels).some(([k, v]) => `${k}=${v}` === label))
    .filter(r => onlyWaiting === null || waiting.has(makeRunKey(r.instance, r.run.id)))
    .toSorted(
      (a, b) =>
        b.run.started.localeCompare(a.run.started) ||
        makeRunKey(a.instance, a.run.id).localeCompare(makeRunKey(b.instance, b.run.id))
    );
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
        {instances.length > 1 && <InstanceFilter picked={picked} />}
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
      {groups.map(
        g =>
          g.failure !== undefined && (
            <p key={g.name} role="alert" className="flex items-center gap-2 text-xs text-amber-600">
              {`${g.value ? `Could not refresh ${g.name}, showing earlier data.` : `Could not read ${g.name || 'the runs'}.`} ${g.failure}`}
              {g.retry && <Button onClick={g.retry}>Retry</Button>}
            </p>
          )
      )}
      {missing.some(g => g.failure === undefined) && <Loading />}
      {onlyWaiting !== null && !listed.length && !missing.length ? (
        <Muted>Nothing waits for you.</Muted>
      ) : (
        <Rows
          rows={listed.map(r => {
            const row = runRow({
              ...r,
              labels: Object.fromEntries(Object.entries(r.labels).filter(([k]) => !hidden.includes(k))),
            });
            const run = onlyWaiting === null ? undefined : waiting.get(makeRunKey(r.instance, r.run.id));
            return run ? { ...row, open: true, children: [], body: <NextSteps run={run} r={r} /> } : row;
          })}
        />
      )}
    </>
  );
};

/** The runs of the served instances as rows, at `/runs`; one run opened with every trace line at `/runs/<id>`. */
export const RunsPage = () => {
  const { id } = useAtomValue(pageAtom);
  return (
    <div className="flex h-full flex-col">
      <Problems />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{id ? <RunPage id={id} /> : <RunList />}</div>
    </div>
  );
};
