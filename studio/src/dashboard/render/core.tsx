import { memo, type ReactNode, useState } from 'react';
import { Code, Markdown } from '../../Markdown.tsx';
import { Icon } from '../../studio/icons.tsx';
import { cx, Disclosure, IconButton } from '../../ui.tsx';

/** Bot text as markdown, rendered once per text. */
export const Text = memo(function Text({ text }: { text: string }) {
  return <Markdown text={text} />;
});

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
export const JsonView = ({ value, label = 'json' }: { value: unknown; label?: string }) => (
  <Disclosure className="text-xs" summaryClassName="font-mono text-zinc-500" summary={label}>
    <Code code={json(value)} lang="json" />
  </Disclosure>
);

/** Rendered content with a toggle to the raw JSON it came from. */
export const WithRaw = ({ value, children }: { value: unknown; children: ReactNode }) => {
  const [raw, setRaw] = useState(false);
  return (
    <div className="group/raw relative min-w-0">
      <span
        className={cx(
          'absolute top-0 right-0 z-10',
          !raw && 'opacity-0 group-hover/raw:opacity-100 focus-within:opacity-100'
        )}
      >
        <IconButton
          tip={raw ? 'Show the rendered view' : 'Show the raw JSON'}
          variant="ghost"
          aria-pressed={raw}
          onClick={() => setRaw(!raw)}
        >
          <Icon name="raw" className="size-3" />
        </IconButton>
      </span>
      {raw ? <Code code={json(value)} lang="json" /> : children}
    </div>
  );
};

/** A small muted label in front of a value. */
export const Label = ({ children }: { children: ReactNode }) => (
  <span className="text-[11px] text-zinc-500">{children}</span>
);
