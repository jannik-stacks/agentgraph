import { type ReactNode, useState } from 'react';
import { Button, cx, field } from '../ui.tsx';
import { fold } from './collapse.ts';

export type Row = {
  key: string;
  label: string;
  icon: ReactNode;
  meta?: ReactNode;
  search?: string;
  onPick: () => void;
};

const rowClass =
  'flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-[13px] hover:bg-zinc-50 dark:hover:bg-zinc-900';

const RowButton = ({ row }: { row: Row }) => (
  <button type="button" onClick={row.onPick} className={rowClass}>
    {row.icon}
    <span className="truncate font-medium">{row.label}</span>
    {row.meta}
  </button>
);

const frame = 'divide-y divide-zinc-100 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800';

/** The first rows up to the fan limit, then one row that opens all of them. */
export const RowPreview = ({ rows, onShowAll }: { rows: Row[]; onShowAll: () => void }) => {
  const { shown, rest } = fold(rows);
  return (
    <ul className={frame}>
      {shown.map(row => (
        <li key={row.key}>
          <RowButton row={row} />
        </li>
      ))}
      {rest.length ? (
        <li>
          <button type="button" onClick={onShowAll} className={`${rowClass} text-zinc-500`}>
            <span className="tabular-nums">Show all {rows.length}</span>
            <span className="ml-auto text-[11px] text-zinc-400 tabular-nums">{rest.length} more</span>
          </button>
        </li>
      ) : null}
    </ul>
  );
};

/** Every row of one list, filtered as you type, under a header with a way back. */
export const ItemList = ({
  title,
  rows,
  onBack,
  children,
}: {
  title: ReactNode;
  rows: Row[];
  onBack: () => void;
  children?: ReactNode;
}) => {
  const [query, setQuery] = useState('');
  const words = query.trim().toLowerCase();
  const found = words ? rows.filter(row => `${row.label} ${row.search ?? ''}`.toLowerCase().includes(words)) : rows;
  return (
    <div className="space-y-2">
      <header className="flex min-w-0 items-center gap-2">
        <Button variant="small" onClick={onBack}>
          Back
        </Button>
        <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-500 tabular-nums">
          {found.length === rows.length ? rows.length : `${found.length} of ${rows.length}`}
        </span>
      </header>
      {children}
      <input
        type="search"
        aria-label="Filter"
        placeholder="Filter"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className={cx(field, 'w-full')}
      />
      {found.length ? (
        <ul className={frame}>
          {found.map(row => (
            <li key={row.key}>
              <RowButton row={row} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-400">Nothing matches.</p>
      )}
    </div>
  );
};
