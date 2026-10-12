import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { useSetAtom } from 'jotai';
import { type ComponentProps, type CSSProperties, type ReactNode, Suspense, use } from 'react';
import { navigateAtom } from '../state.ts';
import { files, fileText } from './data.ts';
import { type FileText, lineHash, resolve, type Resolved, sourceHref, summary, type Target } from './model.ts';

/** A link into the source viewer that keeps its `#L` hash. */
export const CodeLink = ({ href, onClick, ...props }: ComponentProps<'a'> & { href: string }) => {
  const navigate = useSetAtom(navigateAtom);
  return (
    <a
      href={href}
      {...props}
      onClick={e => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        const url = new URL(href, location.origin);
        navigate({ path: url.pathname });
        history.replaceState(null, '', `${url.pathname}${url.hash}`);
        dispatchEvent(new HashChangeEvent('hashchange'));
        if (!url.hash) scrollTo(0, 0);
      }}
    />
  );
};

/** Doc comment text with `code` spans. */
export const DocText = ({ text }: { text: string }) =>
  text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part));

const ErrorBox = ({ tag, target, error }: { tag: string; target: Target; error: string }) => (
  <div className="not-prose my-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 font-mono text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
    &lt;{tag} {Object.entries(target).map(([k, v]) => (v ? `${k}="${v}" ` : ''))}/&gt;: {error}
  </div>
);

/** One line of highlighted tokens. */
export const Tokens = ({ text, line }: { text: FileText; line: number }) =>
  text.lines[line - 1]?.map(([content, style], i) => (
    <span key={i} style={text.styles[style] as CSSProperties}>
      {content}
    </span>
  ));

const Snippet = ({ r }: { r: Resolved }) => {
  const text = use(fileText(r.file.path));
  const numbers = Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i);
  return (
    <code>
      {numbers.map(n => [
        <span key={n} className="line">
          <Tokens text={text} line={n} />
        </span>,
        '\n',
      ])}
    </code>
  );
};

const Title = ({ r }: { r: Resolved }) => (
  <span className="flex gap-2 font-mono text-xs">
    <CodeLink href={sourceHref(r.file.path, r.start, r.end)} className="truncate hover:text-fd-primary">
      {r.file.path}
    </CodeLink>
    <span className="ml-auto shrink-0">{lineHash(r.start, r.end).slice(1).replace('-L', '–')}</span>
  </span>
);

/**
 * A verbatim snippet of bothub's source: an exported `symbol` with its doc comment, or the lines inside a
 * `#region`. `file` is needed only when the name is not unique.
 */
export const Source = (t: Target) => {
  const r = resolve(files, t);
  if ('error' in r) return <ErrorBox tag="Source" target={t} error={r.error} />;
  return (
    <CodeBlock title={<Title r={r} />} data-line-numbers data-line-numbers-start={r.start}>
      <Pre>
        <Suspense fallback={<code>…</code>}>
          <Snippet r={r} />
        </Suspense>
      </Pre>
    </CodeBlock>
  );
};

/** A symbol name that links to its definition in the source viewer. */
export const Sym = ({ name, file, children }: { name: string; file?: string; children?: ReactNode }) => {
  const r = resolve(files, { file, symbol: name });
  if ('error' in r) return <ErrorBox tag="Sym" target={{ file, symbol: name }} error={r.error} />;
  return (
    <CodeLink
      href={sourceHref(r.file.path, r.start, r.end)}
      title={[summary(r.doc), r.file.path].filter(Boolean).join('\n')}
      className="not-prose rounded-md border border-fd-border bg-fd-secondary/60 px-1 py-px font-mono text-[0.85em] text-fd-secondary-foreground no-underline transition-colors hover:border-fd-primary/60 hover:text-fd-primary"
    >
      {children ?? name}
    </CodeLink>
  );
};

/** The fields of a zod object schema or a TypeScript object type, with types, defaults and doc comments. */
export const Fields = ({ name, file }: { name: string; file?: string }) => {
  const r = resolve(files, { file, symbol: name });
  if ('error' in r) return <ErrorBox tag="Fields" target={{ file, symbol: name }} error={r.error} />;
  const fields = r.file.tables[r.name];
  if (!fields) return <ErrorBox tag="Fields" target={{ file, symbol: name }} error="not an object type" />;
  const type = Object.fromEntries(
    fields.map(f => [
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
      <p className="-mt-2 mb-4 text-right font-mono text-xs text-fd-muted-foreground">
        <CodeLink href={sourceHref(r.file.path, r.start, r.end)} className="hover:text-fd-primary">
          {r.name} in {r.file.path}
        </CodeLink>
      </p>
    </div>
  );
};

export const codeComponents = { Source, Sym, Fields };
