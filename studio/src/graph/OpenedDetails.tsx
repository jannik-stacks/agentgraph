import { useAtomValue } from 'jotai';
import { Code, Markdown } from '../Markdown.tsx';
import { atLink } from '../runs/trace.ts';
import { runsAtom } from '../state.ts';
import { accent, cx, Disclosure, Field, Fields, Link } from '../ui.tsx';
import { Crumbs, checkModeTips, Section, Term, To } from './panel.tsx';
import type { Fixture } from './scenarios.ts';
import { findAgentUses, findCheckVerdicts } from './trail.ts';

const latest = 12;

const Path = ({ children }: { children: string }) => <p className="font-mono text-zinc-500">{children}</p>;

const Verdicts = ({ fixture, step, name }: { fixture: string; step: string; name: string }) => {
  const { value: runs = [] } = useAtomValue(runsAtom);
  const verdicts = findCheckVerdicts(runs, fixture, step, name);
  if (!verdicts.length) return <p className="text-zinc-500">No run has run it here yet.</p>;
  const failed = verdicts.filter(v => !v.pass).length;
  return (
    <>
      <p className="text-zinc-500">
        Ran {verdicts.length} {verdicts.length === 1 ? 'time' : 'times'}, failed {failed}.
      </p>
      <ul className="space-y-0.5">
        {verdicts.slice(0, latest).map(v => (
          <li key={`${v.run}@${v.at}`}>
            <Disclosure
              summary={
                <span className="flex min-w-0 items-baseline gap-1.5 tabular-nums">
                  <span className={cx(!v.pass && accent.text)}>{v.pass ? 'passed' : 'failed'}</span>
                  <span className="truncate text-zinc-500">
                    #{v.issue}, {v.at.slice(5, 16).replace('T', ' ')}
                    {v.items > 0 && `, ${v.failed} of ${v.items} items failed`}
                  </span>
                </span>
              }
            >
              <div className="space-y-1 pt-1 pl-4">
                {v.findings ? (
                  <Code code={v.findings} compact wrap lines={14} />
                ) : (
                  <p className="text-zinc-500">No findings.</p>
                )}
                <Link href={atLink(v.run, v.at)} className="block text-zinc-500 underline">
                  open in run {v.run}
                </Link>
              </div>
            </Disclosure>
          </li>
        ))}
      </ul>
    </>
  );
};

export const CheckDetails = ({ fixture, path, name }: { fixture: Fixture; path: string; name: string }) => {
  const check = fixture.checks[name];
  const mode = check?.mode ?? 'block';
  const step = path.split('/')[1]!;
  return (
    <div className="space-y-5 p-4 text-xs">
      <div className="space-y-1">
        <Crumbs path={path} />
        <Path>{`checks/${name}.md`}</Path>
      </div>
      <Fields>
        <Field name={<Term tip="What a failure does to the step.">gate</Term>}>
          <Term tip={checkModeTips[mode]}>{mode}</Term>
        </Field>
        <Field name="decided by">
          {check?.agent === undefined ? (
            'a script, exit 0 passes'
          ) : (
            <>
              {check.run ? 'a script, its output judged by ' : 'judged by '}
              <To path={`${path}/agent:${check.agent}`}>{check.agent}</To>
            </>
          )}
        </Field>
      </Fields>
      {check?.run && (
        <Section title="Script">
          <Code code={check.run} lang="sh" compact wrap lines={24} />
        </Section>
      )}
      {check?.body?.trim() && (
        <Section title={check.agent === undefined ? 'Description' : 'What the judge is told'}>
          <Markdown text={check.body} />
        </Section>
      )}
      {fixture.agents && (
        <Section title="Verdicts" tip="What this check said at this step in the runs of the data dir, newest first.">
          <Verdicts fixture={fixture.id} step={step} name={name} />
        </Section>
      )}
    </div>
  );
};

export const AgentDetails = ({
  fixture,
  graph,
  path,
  name,
}: {
  fixture: Fixture;
  graph: Fixture[];
  path: string;
  name: string;
}) => {
  const role = fixture.roles?.[name];
  const body = fixture.agents?.[name];
  const uses = findAgentUses(graph, name);
  const several = new Set(uses.steps.map(s => s.workflow)).size > 1;
  return (
    <div className="space-y-5 p-4 text-xs">
      <div className="space-y-1">
        <Crumbs path={path} />
        <Path>{`agents/${name}.md`}</Path>
      </div>
      {role && (
        <Fields>
          <Field name={<Term tip="The model alias the agent asks the proxy for.">model</Term>}>
            {role.model ?? 'the default'}
          </Field>
          <Field
            name={<Term tip="What the agent may write to GitHub; the engine refuses any other kind.">returns</Term>}
          >
            {role.returns.length ? role.returns.join(', ') : 'nothing'}
          </Field>
          {role.reads && (
            <Field name={<Term tip="What the agent may read besides the checkout.">reads</Term>}>{role.reads}</Field>
          )}
        </Fields>
      )}
      <Section title="Used by">
        {uses.steps.length + uses.checks.length === 0 ? (
          <p className="text-zinc-500">No step or check uses it.</p>
        ) : (
          <ul className="space-y-0.5">
            {uses.steps.map(s => (
              <li key={s.path}>
                runs <To path={s.path}>{s.name}</To>
                {several && <span className="text-zinc-500"> in {s.workflow}</span>}
              </li>
            ))}
            {uses.checks.map(c => (
              <li key={c.name}>
                judges {c.path ? <To path={c.path}>{c.name}</To> : <span className="font-mono">{c.name}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {body?.trim() && (
        <Section title="System prompt">
          <Markdown text={body} />
        </Section>
      )}
    </div>
  );
};
