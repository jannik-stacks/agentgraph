import { useMemo, useState } from 'react';
import type { readFiles } from '../../../src/api.ts';
import { highlight } from './highlight.tsx';

export type SourceFile = Awaited<ReturnType<typeof readFiles>>[number];

const CopyButton = ({ label, text }: { label: string; text: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      onClick={() => void copy()}
      className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {copied ? 'copied' : label}
    </button>
  );
};

/** A read-only, highlighted source file with copy buttons for its path and content. */
export const SourceView = ({ file }: { file: SourceFile }) => {
  const body = useMemo(() => highlight(file.path, file.source), [file]);
  return (
    <div className="min-w-0 overflow-hidden rounded border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900">
        <span className="truncate font-mono text-xs text-zinc-500">
          {file.root}/{file.path}
        </span>
        <span className="ml-auto flex shrink-0 gap-1">
          <CopyButton label="copy path" text={file.path} />
          <CopyButton label="copy" text={file.source} />
        </span>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-5">{body}</pre>
    </div>
  );
};
