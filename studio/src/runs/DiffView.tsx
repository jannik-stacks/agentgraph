import { useAtom } from 'jotai';
import { type CSSProperties, Fragment, memo, type ReactNode, useMemo, useState } from 'react';
import { langOf } from '../source/lang.ts';
import { useHighlighted } from '../source/highlight.tsx';
import { cx, Disclosure, Tooltip } from '../ui.tsx';
import { emphasisOf, type Hunk, hunksOf, type Kind, type Line, type Span } from './diff-lines.ts';
import { type FileDiff, hideWhitespaceAtom, totals } from './pulls.ts';
import { AddLineNote, LineNotes, type Side, useLines } from './Review.tsx';

/** Added and removed lines keep the usual green and red: a light wash for the row, a stronger mark for changed words. */
const kindLooks: Record<Kind, { wash: string; mark: string; gutter: string } | undefined> = {
  add: {
    wash: 'bg-emerald-50 dark:bg-emerald-500/15',
    mark: 'bg-emerald-200 dark:bg-emerald-500/40',
    gutter: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  },
  del: {
    wash: 'bg-red-50 dark:bg-red-500/15',
    mark: 'bg-red-200 dark:bg-red-500/40',
    gutter: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  ctx: undefined,
};
const signs: Record<Kind, string> = { add: '+', del: '-', ctx: ' ' };
const tab = 4;

const flush = { '--padding-left': '0', '--padding-right': '0', tabSize: tab } as CSSProperties;
const codeInset = '0.25rem';

/**
 * A row's background under the code: the wash of an added or removed line, and the changed words marked in a stronger
 * tint of the same color, placed by column so the highlighted text above stays as shiki drew it.
 */
const RowTint = ({ kind, spans }: { kind: Kind; spans: [number, number][] | undefined }) => {
  const look = kindLooks[kind];
  if (!look) return <div className="h-5" />;
  return (
    <div className={cx('relative h-5', look.wash)}>
      {spans?.map(([from, to]) => (
        <span
          key={from}
          className={cx('absolute inset-y-px rounded-[3px]', look.mark)}
          style={{ left: `calc(${codeInset} + ${from}ch)`, width: `${Math.max(to - from, 0.5)}ch` }}
        />
      ))}
    </div>
  );
};

/** Which side of the diff a line is on, and its number there. */
const sideOf = (line: Line): [Side, number] => (line.kind === 'del' ? ['old', line.old ?? 0] : ['new', line.new ?? 0]);

/**
 * Rows `from` to `to` of a hunk: a gutter with both line numbers and the sign, and the code, colored in place once
 * shiki has loaded. Every row is one fixed line high and the code never wraps, so the gutter, the row tints and the
 * code stay aligned.
 */
const Rows = ({
  lines,
  from,
  lang,
  path,
  emphasis,
}: {
  lines: Line[];
  from: number;
  lang: string;
  path: string;
  emphasis: Map<number, Span[]>;
}) => {
  const code = useHighlighted(lines.map(l => l.text).join('\n'), lang);
  return (
    <div className="flex">
      <div className="shrink-0 select-none tabular-nums">
        {lines.map((line, i) => {
          const look = kindLooks[line.kind];
          const [side, number] = sideOf(line);
          return (
            <div
              key={i}
              className={cx(
                'group relative grid h-5 w-[5.5rem] grid-cols-[2.25rem_2.25rem_1rem]',
                look ? look.gutter : 'text-zinc-400 dark:text-zinc-600'
              )}
            >
              <span aria-hidden className="pr-1 text-right">
                {line.old ?? ''}
              </span>
              <span aria-hidden className="pr-1 text-right">
                {line.new ?? ''}
              </span>
              <span aria-hidden className="text-center">
                {signs[line.kind]}
              </span>
              <AddLineNote path={path} side={side} line={number} />
            </div>
          );
        })}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="relative w-max min-w-full">
          <div aria-hidden className="absolute inset-0">
            {lines.map((line, i) => (
              <RowTint key={i} kind={line.kind} spans={emphasis.get(from + i)} />
            ))}
          </div>
          <pre className="shiki relative bg-transparent! pr-4 leading-5" style={{ ...flush, paddingLeft: codeInset }}>
            {code}
          </pre>
        </div>
      </div>
    </div>
  );
};

/** One hunk: its header, then its rows, broken after every line that has comments to show them under it. */
const HunkView = ({ hunk, lang, path }: { hunk: Hunk; lang: string; path: string }) => {
  const emphasis = useMemo(() => emphasisOf(hunk.lines, tab), [hunk]);
  const notes = useLines();
  const ends = hunk.lines.flatMap((line, i) => (notes?.has(path, ...sideOf(line)) ? [i + 1] : []));
  const breaks = [0, ...ends.filter(end => end < hunk.lines.length), hunk.lines.length];
  return (
    <>
      <div className="flex bg-zinc-100 text-zinc-500 dark:bg-zinc-900">
        <span className="w-[5.5rem] shrink-0" />
        <span className="truncate px-2">{hunk.header}</span>
      </div>
      {breaks.slice(1).map((to, i) => {
        const from = breaks[i] ?? 0;
        const [side, line] = sideOf(hunk.lines[to - 1]!);
        return (
          <Fragment key={from}>
            <Rows lines={hunk.lines.slice(from, to)} from={from} lang={lang} path={path} emphasis={emphasis} />
            <LineNotes path={path} side={side} line={line} />
          </Fragment>
        );
      })}
    </>
  );
};

/** Added and deleted lines as `+12 -3`, green and red. */
const Counts = ({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) => (
  <span className={cx('inline-flex shrink-0 gap-1.5 font-mono tabular-nums', className)}>
    <span className="text-emerald-700 dark:text-emerald-400">+{additions}</span>
    <span className="text-red-700 dark:text-red-400">-{deletions}</span>
  </span>
);

/** Files with more changed lines than this start folded. */
const largeFile = 400;

const statusLabel: Record<FileDiff['status'], string> = { added: 'new', deleted: 'deleted', modified: '' };

const Note = ({ children }: { children: ReactNode }) => <p className="px-3 py-2 text-xs text-zinc-500">{children}</p>;

const FileBody = ({ file }: { file: FileDiff }) => {
  if (file.binary) return <Note>Binary file, not shown.</Note>;
  if (file.tooLarge)
    return <Note>{(file.additions + file.deletions).toLocaleString()} changed lines, too large to show here.</Note>;
  if (file.patch === undefined) return null;
  const hunks = hunksOf(file.patch);
  if (!hunks.length) return <Note>No changed lines.</Note>;
  const lang = langOf(file.path);
  return (
    <div className="font-mono text-[11.5px]">
      {hunks.map((hunk, i) => (
        <HunkView key={i} hunk={hunk} lang={lang} path={file.path} />
      ))}
    </div>
  );
};

/**
 * One file of a diff in a folding section: its path, what happened to it and its line counts, then its hunks. Large,
 * binary and oversized files start folded.
 */
const FileSection = memo(function FileSection({
  file,
  open,
  onToggle,
}: {
  file: FileDiff;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const label = statusLabel[file.status];
  return (
    <Disclosure
      open={open}
      onToggle={onToggle}
      className="scroll-mt-2 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800"
      summaryClassName="sticky top-0 z-10 bg-zinc-50 px-2 py-1 text-xs dark:bg-zinc-900"
      summary={
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Counts additions={file.additions} deletions={file.deletions} />
          <span className="min-w-0 truncate font-mono">{file.path}</span>
          {label && <span className="shrink-0 text-zinc-500">{label}</span>}
        </span>
      }
    >
      <div className="border-t border-zinc-200 dark:border-zinc-800">
        <FileBody file={file} />
      </div>
    </Disclosure>
  );
});

const startsOpen = (file: FileDiff) => !file.binary && !file.tooLarge && file.additions + file.deletions <= largeFile;

/** Which files are open, starting from `startsOpen`, with a way to open one from elsewhere. */
export const useOpenFiles = () => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return {
    isOpen: (file: FileDiff) => open[file.path] ?? startsOpen(file),
    set: (path: string, value: boolean) => setOpen(o => ({ ...o, [path]: value })),
  };
};

/** How many files had only whitespace changes and are left out. */
const HiddenFiles = ({ count }: { count: number | undefined }) =>
  count ? (
    <p className="text-xs text-zinc-500">
      {count} {count === 1 ? 'file' : 'files'} with only whitespace changes hidden
    </p>
  ) : null;

/** Every file of a diff, one section each, and how many files only changed whitespace when those are hidden. */
export const DiffFiles = ({
  files,
  hiddenFiles,
  open,
}: {
  files: FileDiff[];
  hiddenFiles?: number | undefined;
  open?: ReturnType<typeof useOpenFiles>;
}) => {
  const own = useOpenFiles();
  const state = open ?? own;
  if (!files.length)
    return (
      <div className="space-y-1">
        <p className="text-xs text-zinc-500">No changes.</p>
        <HiddenFiles count={hiddenFiles} />
      </div>
    );
  return (
    <div className="space-y-2">
      <HiddenFiles count={hiddenFiles} />
      {files.map(file => (
        <FileSection key={file.path} file={file} open={state.isOpen(file)} onToggle={v => state.set(file.path, v)} />
      ))}
    </div>
  );
};

/** A diff's size in one line: files, then added and deleted lines. */
export const DiffSummary = ({ files }: { files: Pick<FileDiff, 'additions' | 'deletions'>[] }) => {
  const { additions, deletions } = totals(files);
  return (
    <Tooltip
      tip={`${files.length} ${files.length === 1 ? 'file' : 'files'} changed, ${additions} lines added, ${deletions} deleted`}
    >
      <span className="inline-flex items-center gap-2 text-xs">
        <Counts additions={additions} deletions={deletions} />
        <span className="text-zinc-500 tabular-nums">
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
      </span>
    </Tooltip>
  );
};

/** A small switch that hides or shows changes made only of whitespace in every diff. */
export const WhitespaceToggle = () => {
  const [hide, setHide] = useAtom(hideWhitespaceAtom);
  return (
    <Tooltip
      tip={
        hide ? 'Changes made only of whitespace are hidden; click to show them' : 'Hide changes made only of whitespace'
      }
    >
      <button
        type="button"
        aria-pressed={hide}
        onClick={() => setHide(!hide)}
        className={cx(
          'shrink-0 rounded border px-1.5 py-px text-[11px] leading-4',
          hide
            ? 'border-zinc-500 text-zinc-900 dark:border-zinc-400 dark:text-zinc-100'
            : 'border-zinc-200 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700'
        )}
      >
        hide whitespace
      </button>
    </Tooltip>
  );
};
