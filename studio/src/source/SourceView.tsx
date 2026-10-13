import { type CSSProperties, useState } from 'react';
import type { readFiles } from '../../../src/api.ts';
import { Button } from '../ui.tsx';
import { useHighlighted } from './highlight.tsx';
import { langOf } from './lang.ts';

export type SourceFile = Awaited<ReturnType<typeof readFiles>>[number];

const CopyButton = ({ label, text }: { label: string; text: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <Button variant="small" onClick={() => void copy()}>
      {copied ? 'copied' : label}
    </Button>
  );
};

const flush = { '--padding-left': '0', '--padding-right': '0' } as CSSProperties;

/** A read-only, highlighted source file under a row with its path and copy buttons, flush with its container. */
export const SourceView = ({ file }: { file: SourceFile }) => (
  <div className="min-w-0">
    <div className="flex items-center gap-2 border-b border-zinc-200 pb-1.5 dark:border-zinc-800">
      <span className="truncate font-mono text-xs text-zinc-500">
        {file.root}/{file.path}
      </span>
      <span className="ml-auto flex shrink-0 gap-1">
        <CopyButton label="copy path" text={file.path} />
        <CopyButton label="copy" text={file.source} />
      </span>
    </div>
    <pre className="shiki overflow-x-auto pt-2 font-mono text-xs leading-5" style={flush}>
      {useHighlighted(file.source, langOf(file.path))}
    </pre>
  </div>
);
