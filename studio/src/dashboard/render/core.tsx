import { memo, type ReactNode, useState } from 'react';
import { Code, Markdown } from '../../Markdown.tsx';
import { Icon } from '../../studio/icons.tsx';
import { cx, Tooltip } from '../../ui.tsx';

/** Bot text as markdown, rendered once per text. */
export const Text = memo(function Text({ text }: { text: string }) {
  return <Markdown text={text} />;
});

/** A highlighted code block. */
export const Highlighted = Code;

export const json = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value);

/** Parses text that holds a JSON object or array, else undefined. */
export const parseJson = (text: string | undefined): unknown => {
  const trimmed = text?.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return;
  try {
    return JSON.parse(trimmed);
  } catch {
    return;
  }
};

/** Collapsed highlighted JSON; highlighting happens only once opened. */
export const JsonView = ({ value, label = 'json' }: { value: unknown; label?: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={e => setOpen(e.currentTarget.open)} className="text-xs">
      <summary className="cursor-pointer select-none font-mono text-zinc-500">{label}</summary>
      {open && <Highlighted code={json(value)} lang="json" />}
    </details>
  );
};

/** Rendered content with a toggle to the raw JSON it came from. */
export const WithRaw = ({ value, children }: { value: unknown; children: ReactNode }) => {
  const [raw, setRaw] = useState(false);
  return (
    <div className="group/raw relative min-w-0">
      <Tooltip
        tip={raw ? 'Show the rendered view' : 'Show the raw JSON'}
        className={cx(
          'absolute top-0 right-0 z-10',
          !raw && 'opacity-0 group-hover/raw:opacity-100 focus-within:opacity-100'
        )}
      >
        <button
          type="button"
          aria-label="Raw JSON"
          aria-pressed={raw}
          onClick={() => setRaw(!raw)}
          className="rounded p-0.5 text-zinc-400 hover:text-sky-600 dark:hover:text-sky-400"
        >
          <Icon name="raw" className="size-3" />
        </button>
      </Tooltip>
      {raw ? <Highlighted code={json(value)} lang="json" /> : children}
    </div>
  );
};

/** A small muted label in front of a value. */
export const Label = ({ children }: { children: ReactNode }) => (
  <span className="text-[11px] text-zinc-500">{children}</span>
);
