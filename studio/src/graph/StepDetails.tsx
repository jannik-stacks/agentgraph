import { useAtomValue } from 'jotai';
import { Markdown } from '../Markdown.tsx';
import { age, PhaseWord } from '../runs/bits.tsx';
import { live } from '../runs/live.ts';
import { phaseOf } from '../runs/model.ts';
import { Field, Fields, Link } from '../ui.tsx';
import type { Step } from './model.ts';

const nameOf = (id: string) => id.slice(id.indexOf('/') + 1);

/** A step's bot, checks, tries and where it leads, its prose, and its latest runs. */
export const StepDetails = ({ step }: { step: Step }) => {
  const rows = useAtomValue(live.rows);
  const runs = (rows ?? []).filter(r => r.workflow === step.workflow && r.job === step.name && !r.check).slice(0, 8);
  return (
    <div className="space-y-4 p-4 text-xs">
      <div>
        <h2 className="text-sm font-semibold">{step.name}</h2>
        <p className="text-zinc-500">in {step.workflow}</p>
      </div>
      <Fields>
        {step.bot && <Field name="bot">{step.bot}</Field>}
        {step.run !== undefined && <Field name="runs">a command</Field>}
        {step.checks.length > 0 && <Field name="checks">{step.checks.join(', ')}</Field>}
        {step.tries && <Field name="tries">{step.tries}</Field>}
        {step.next.length > 0 && <Field name="next">{step.next.map(nameOf).join(', ')}</Field>}
        {step.back.map(back => (
          <Field key={back.to} name="back">
            {nameOf(back.to)} when {back.label}
          </Field>
        ))}
      </Fields>
      <section className="space-y-1">
        <h3 className="font-medium text-zinc-500">Latest runs</h3>
        {runs.length ? (
          <ul className="space-y-0.5">
            {runs.map(run => (
              <li key={run.id}>
                <Link href={`/runs/${encodeURIComponent(run.id)}`} className="flex items-center gap-2 hover:underline">
                  <span className="min-w-0 flex-1 truncate">
                    {run.event.number !== undefined ? `#${run.event.number}` : run.event.trigger}
                    {(run.attempt ?? 1) > 1 && `, try ${run.attempt}`}
                  </span>
                  <PhaseWord phase={phaseOf(run)} status={run.status} />
                  <span className="w-14 shrink-0 text-right text-zinc-500">{age(run.startedAt ?? run.event.ts)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-zinc-500">No runs yet.</p>
        )}
      </section>
      {step.about && (
        <section className="space-y-1">
          <h3 className="font-medium text-zinc-500">{step.bot ? 'Skill' : 'Command'}</h3>
          <Markdown text={step.bot ? step.about : `\`\`\`sh\n${step.about}\n\`\`\``} />
        </section>
      )}
    </div>
  );
};
