import { type ComponentProps, memo, type ReactNode, useState } from 'react';
import { Code, Markdown } from '../../Markdown.tsx';
import { Icon } from '../../studio/icons.tsx';
import { Disclosure, IconButton } from '../../ui.tsx';

/** Bot text as markdown, rendered once per text. */
export const Text = memo(function Text({
  text,
  fences,
}: {
  text: string;
  fences?: ComponentProps<typeof Markdown>['fences'];
}) {
  return <Markdown text={text} fences={fences} />;
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

/** JSON as data: small, wrapped, a few lines until expanded. */
export const Raw = ({ value }: { value: unknown }) => <Code code={json(value)} lang="json" compact wrap lines={12} />;

/** Collapsed JSON; highlighting happens only once opened. */
export const JsonView = ({ value, label = 'json' }: { value: unknown; label?: string }) => (
  <Disclosure className="text-xs" summaryClassName="font-mono text-zinc-500" summary={label}>
    <Raw value={value} />
  </Disclosure>
);

/** The button that switches between a rendered view and the raw JSON it came from. */
export const RawToggle = ({ raw, onToggle }: { raw: boolean; onToggle: () => void }) => (
  <IconButton
    tip={raw ? 'Show the rendered view' : 'Show the raw JSON'}
    variant="quiet"
    aria-pressed={raw}
    onClick={onToggle}
  >
    <Icon name="raw" className="size-3" />
  </IconButton>
);

/** Rendered content under `head`, with a toggle at the end of the head's line to the raw JSON it came from. */
export const WithRaw = ({ value, head, children }: { value: unknown; head: ReactNode; children: ReactNode }) => {
  const [raw, setRaw] = useState(false);
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-h-5 min-w-0 items-center gap-1.5">
        {head}
        <RawToggle raw={raw} onToggle={() => setRaw(!raw)} />
      </div>
      {raw ? <Raw value={value} /> : children}
    </div>
  );
};

/** A small muted label in front of a value. */
export const Label = ({ children }: { children: ReactNode }) => (
  <span className="text-[11px] text-zinc-500">{children}</span>
);
