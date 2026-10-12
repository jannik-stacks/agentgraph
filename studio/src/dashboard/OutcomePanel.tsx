import type { ApplyResult } from '../../../src/apply.ts';
import type { Proposal } from '../../../src/outputs.ts';
import type { Outcome } from '../../../src/store.ts';
import type { Tone } from '../graph-model.ts';
import { Badge, Pre, Section } from '../ui.tsx';

const ProposalView = ({ proposal }: { proposal: Proposal }) => {
  const { kind, ...fields } = proposal;
  return (
    <div className="space-y-1">
      <Badge tone="info">{kind}</Badge>
      <Pre>{JSON.stringify(fields, null, 2)}</Pre>
    </div>
  );
};

const resultTone: Record<ApplyResult['status'], Tone> = { applied: 'ok', skipped: 'neutral', failed: 'danger' };

export const OutcomePanel = ({ outcome }: { outcome: Outcome }) => (
  <div className="space-y-4">
    <Section title={`proposals (${outcome.proposals.length})`}>
      {outcome.proposals.map((proposal, i) => (
        <ProposalView key={i} proposal={proposal} />
      ))}
      {outcome.errors.map((error, i) => (
        <p key={i} className="text-red-600 dark:text-red-400">
          {error}
        </p>
      ))}
    </Section>
    {outcome.rejected.length > 0 && (
      <Section title={`rejected (${outcome.rejected.length})`}>
        {outcome.rejected.map(({ proposal, reason }, i) => (
          <div key={i} className="space-y-1">
            <p className="text-red-600 dark:text-red-400">{reason}</p>
            <ProposalView proposal={proposal} />
          </div>
        ))}
      </Section>
    )}
    <Section title={outcome.applied ? 'applied' : 'not applied'}>
      {outcome.results.length ? (
        <ul className="space-y-1">
          {outcome.results.map((result, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Badge tone={resultTone[result.status]}>{result.status}</Badge>
              <span className="font-mono">{result.kind}</span>
              {result.url && (
                <a
                  className="text-sky-600 underline dark:text-sky-400"
                  href={result.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {result.url}
                </a>
              )}
              {result.reason && <span className="text-zinc-500">{result.reason}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-zinc-500">Nothing reached GitHub.</p>
      )}
    </Section>
  </div>
);
