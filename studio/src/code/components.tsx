import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import type { ReactNode } from 'react';
import { css, refs, root } from 'virtual:bothub-code';
import { Tooltip } from '../ui.tsx';
import { type Ref, refKey, type Tag, type Target } from './model.ts';

type Found = Exclude<Ref, { error: string }>;

const lines = ({ start, end }: Found) => (start === end ? `${start}` : `${start}-${end}`);

/** Opens the lines in VS Code. */
const editorHref = (r: Found) => `vscode://file/${root}/${r.path}:${r.start}`;

/** Doc comment text with `code` spans. */
const DocText = ({ text }: { text: string }) =>
  text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part));

const ErrorBox = ({ tag, target, error }: { tag: string; target: Target; error: string }) => (
  <div className="not-prose my-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 font-mono text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
    &lt;{tag} {Object.entries(target).map(([k, v]) => (v ? `${k}="${v}" ` : ''))}/&gt;: {error}
  </div>
);

const lookup = (tag: Tag, target: Target, render: (r: Found) => ReactNode) => {
  const r = refs[refKey(tag, target)] ?? { error: 'not collected yet, reload the page' };
  return 'error' in r ? <ErrorBox tag={tag} target={target} error={r.error} /> : render(r);
};

const Where = ({ r, children }: { r: Found; children?: ReactNode }) => (
  <Tooltip action="Open in VS Code">
    <a href={editorHref(r)} className="font-mono hover:text-fd-primary">
      {children ?? `${r.path}:${lines(r)}`}
    </a>
  </Tooltip>
);

/**
 * A verbatim snippet of bothub's source: a `symbol` with its doc comment, or the lines inside a `#region`. `file` is
 * needed only when the name is not unique or not exported.
 */
export const Source = (t: Target) =>
  lookup('Source', t, r => (
    <CodeBlock title={<Where r={r} />} data-line-numbers data-line-numbers-start={r.start}>
      <style href="bothub-code" precedence="default">
        {css}
      </style>
      <Pre>
        <code dangerouslySetInnerHTML={{ __html: r.html ?? '' }} />
      </Pre>
    </CodeBlock>
  ));

/** A symbol name in prose, showing its summary and location on hover. */
export const Sym = ({ name, file, children }: { name: string; file?: string; children?: ReactNode }) =>
  lookup('Sym', { file, symbol: name }, r => (
    <Tooltip tip={[r.summary, `${r.path}:${lines(r)}`].filter(Boolean).join('\n')} action="Open in VS Code">
      <a
        href={editorHref(r)}
        className="not-prose rounded-md border border-fd-border bg-fd-secondary/60 px-1 py-px font-mono text-[0.85em] text-fd-secondary-foreground no-underline transition-colors hover:border-fd-primary/60 hover:text-fd-primary"
      >
        {children ?? name}
      </a>
    </Tooltip>
  ));

/** The fields of a zod object schema or a TypeScript object type, with types, defaults and doc comments. */
export const Fields = ({ name, file }: { name: string; file?: string }) =>
  lookup('Fields', { file, symbol: name }, r => {
    const type = Object.fromEntries(
      (r.fields ?? []).map(f => [
        f.name,
        {
          type: <code>{f.type}</code>,
          required: f.required,
          ...(f.full && { typeDescription: <code>{f.full}</code> }),
          ...(f.default && { default: <code>{f.default}</code> }),
          ...(f.doc && { description: <DocText text={f.doc} /> }),
        },
      ])
    );
    return (
      <div>
        <TypeTable type={type} />
        <p className="-mt-2 mb-4 text-right text-xs text-fd-muted-foreground">
          <Where r={r}>
            {r.name} in {r.path}:{lines(r)}
          </Where>
        </p>
      </div>
    );
  });

export const codeComponents = { Source, Sym, Fields };
