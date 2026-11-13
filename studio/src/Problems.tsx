import { shown } from './state.ts';

export const Problems = () =>
  shown?.problems.length ? (
    <ul className="list-disc space-y-1 border-b border-zinc-200 py-2 pr-4 pl-8 text-xs dark:border-zinc-800">
      {shown.problems.map((p, i) => (
        <li key={i}>
          {shown?.title} does not load: <span className="font-mono">{p.path}</span>, {p.message}
        </li>
      ))}
    </ul>
  ) : null;
