import { served } from 'virtual:fixtures';

/** What stops the served graph from loading, when anything does. */
export const Problems = () =>
  served?.problems.length ? (
    <ul className="list-disc space-y-1 border-b border-zinc-200 py-2 pr-4 pl-8 text-xs dark:border-zinc-800">
      {served.problems.map((p, i) => (
        <li key={i}>
          {served?.name} does not load: <span className="font-mono">{p.path}</span>, {p.message}
        </li>
      ))}
    </ul>
  ) : null;
