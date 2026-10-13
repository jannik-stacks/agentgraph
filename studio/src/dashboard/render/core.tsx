import { memo, type ReactNode, useState } from 'react';
import { Code, Markdown } from '../../Markdown.tsx';
import { Icon } from '../../studio/icons.tsx';
import { Disclosure, IconButton } from '../../ui.tsx';

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

const RawToggle = ({ raw, onToggle }: { raw: boolean; onToggle: () => void }) => (
  <IconButton
    tip={raw ? 'Show the rendered view' : 'Show the raw JSON'}
    variant="quiet"
    aria-pressed={raw}
    onClick={onToggle}
  >
    <Icon name="raw" className="size-3" />
  </IconButton>
);

/**
 * Rendered content with a toggle to the raw JSON it came from. The toggle follows `head` on its line; without a head it
 * sits in the indent to the left of the content.
 */
export const WithRaw = ({ value, head, children }: { value: unknown; head?: ReactNode; children: ReactNode }) => {
  const [raw, setRaw] = useState(false);
  const toggle = <RawToggle raw={raw} onToggle={() => setRaw(!raw)} />;
  const body = raw ? <Code code={json(value)} lang="json" /> : children;
  if (head)
    return (
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {head}
          {toggle}
        </div>
        {body}
      </div>
    );
  return (
    <div className="relative min-w-0">
      <span className="absolute top-0 -left-6">{toggle}</span>
      {body}
    </div>
  );
};

/** A small muted label in front of a value. */
export const Label = ({ children }: { children: ReactNode }) => (
  <span className="text-[11px] text-zinc-500">{children}</span>
);
