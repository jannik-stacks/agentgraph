import type { Run } from '../../../src/store.ts';
import { Badge, cx, statusTone } from '../ui.tsx';

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
const steps: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', Infinity],
];

export const age = (iso: string, now = Date.now()) => {
  let value = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return iso;
};

export const cost = (usd: number | undefined) => (usd === undefined ? '-' : `$${usd.toFixed(3)}`);

export const RunTable = ({
  runs,
  selected,
  onSelect,
}: {
  runs: Run[];
  selected: string | null;
  onSelect: (id: string) => void;
}) => (
  <table className="w-full text-left">
    <thead className="sticky top-0 bg-white text-xs text-zinc-500 dark:bg-zinc-950">
      <tr>
        <th className="px-3 py-2 font-medium">status</th>
        <th className="px-3 py-2 font-medium">workflow / job</th>
        <th className="px-3 py-2 text-right font-medium">cost</th>
        <th className="px-3 py-2 text-right font-medium">age</th>
      </tr>
    </thead>
    <tbody>
      {runs.map(run => (
        <tr
          key={run.id}
          onClick={() => onSelect(run.id)}
          className={cx(
            'cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900',
            run.id === selected && 'bg-sky-50 dark:bg-sky-950/40'
          )}
        >
          <td className="px-3 py-1.5">
            <Badge tone={statusTone(run.status)}>{run.status}</Badge>
          </td>
          <td className="px-3 py-1.5">
            <div>
              {run.workflow} / {run.job}
            </div>
            {run.persona && <div className="text-xs text-zinc-500">{run.persona}</div>}
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums">{cost(run.costUsd)}</td>
          <td className="px-3 py-1.5 text-right text-zinc-500" title={run.startedAt ?? run.event.ts}>
            {age(run.startedAt ?? run.event.ts)}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);
