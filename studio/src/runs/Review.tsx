import { createContext, type ReactNode, use, useMemo, useState } from 'react';
import type { PullComment } from '../../../src/pulls.ts';
import type { Run } from '../../../src/store.ts';
import { Markdown } from '../Markdown.tsx';
import { Icon } from '../icons.tsx';
import { accent, Button, cx, field, IconButton, Segmented, Tooltip } from '../ui.tsx';
import { age } from './bits.tsx';

export type Side = 'old' | 'new';
type LineDraft = { path: string; side: Side; line: number; body: string };

const keyOf = (path: string, side: Side, line: number) => `${side}:${line}:${path}`;

/** Line comments shown in a diff, the ones collected for the next review, and the line being written on. */
type Lines = {
  comments: Map<string, PullComment[]>;
  drafts: LineDraft[];
  writing: string | undefined;
  has: (path: string, side: Side, line: number) => boolean;
  open: (path: string, side: Side, line: number) => void;
  close: () => void;
  add: (draft: LineDraft) => void;
  remove: (draft: LineDraft) => void;
};

const LinesContext = createContext<Lines | undefined>(undefined);

/** The line comments of the diff below, when it belongs to a merge request that takes comments. */
export const useLines = () => use(LinesContext);

const Thread = ({ comments }: { comments: PullComment[] }) =>
  comments.length ? (
    <ul className="space-y-2">
      {comments.map((comment, i) => (
        <li key={i} className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">{comment.author}</span>
            {comment.path && (
              <span className="font-mono">
                {comment.path}:{comment.line}
              </span>
            )}
            <span className="ml-auto">{age(comment.ts)}</span>
          </div>
          <Markdown text={comment.body} />
        </li>
      ))}
    </ul>
  ) : null;

/** A Markdown text area with a preview tab. */
const Editor = ({
  value,
  onChange,
  placeholder,
  rows = 4,
  autoFocus = false,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  rows?: number;
  autoFocus?: boolean;
}) => {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  return (
    <div className="space-y-1">
      <Segmented options={['write', 'preview'] as const} value={tab} onChange={setTab} className="text-[11px]" />
      {tab === 'write' ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          autoFocus={autoFocus}
          className={cx(field, 'block w-full resize-y font-sans text-xs')}
        />
      ) : (
        <div className="min-h-16 rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800">
          {value.trim() ? <Markdown text={value} /> : <p className="text-xs text-zinc-500">Nothing to preview.</p>}
        </div>
      )}
    </div>
  );
};

/** The comments under one diff line: posted ones, ones collected for the review, and the box to write one. */
export const LineNotes = ({ path, side, line }: { path: string; side: Side; line: number }) => {
  const lines = useLines();
  const [text, setText] = useState('');
  if (!lines) return null;
  const key = keyOf(path, side, line);
  const posted = lines.comments.get(key) ?? [];
  const drafts = lines.drafts.filter(d => keyOf(d.path, d.side, d.line) === key);
  const writing = lines.writing === key;
  if (!posted.length && !drafts.length && !writing) return null;
  return (
    <div className="space-y-2 border-y border-zinc-200 bg-zinc-50 px-3 py-2 font-sans dark:border-zinc-800 dark:bg-zinc-900/60">
      <Thread comments={posted} />
      {drafts.map((draft, i) => (
        <div
          key={i}
          className={
            'flex items-start gap-2 rounded-md border border-dashed border-zinc-300 px-3 py-2 dark:border-zinc-700'
          }
        >
          <span className="shrink-0 text-[11px] text-zinc-500">pending</span>
          <Markdown text={draft.body} className="min-w-0 flex-1" />
          <IconButton tip="Remove this line comment" variant="ghost" onClick={() => lines.remove(draft)}>
            <Icon name="fail" className="size-3" />
          </IconButton>
        </div>
      ))}
      {writing && (
        <div className="space-y-1">
          <Editor value={text} onChange={setText} placeholder="Comment on this line" rows={3} autoFocus />
          <div className="flex gap-2">
            <Tooltip tip="Collects this line comment into your review; it is sent with the comment at the bottom">
              <Button
                variant="primary"
                disabled={!text.trim()}
                onClick={() => {
                  lines.add({ path, side, line, body: text.trim() });
                  setText('');
                }}
              >
                Add to review
              </Button>
            </Tooltip>
            <Button onClick={lines.close}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
};

/** The "+" in a diff line's gutter that opens a comment on that line. */
export const AddLineNote = ({ path, side, line }: { path: string; side: Side; line: number }) => {
  const lines = useLines();
  if (!lines) return null;
  return (
    <button
      type="button"
      aria-label={`Comment on line ${line}`}
      onClick={() => lines.open(path, side, line)}
      className="absolute top-0.5 left-0.5 hidden size-4 items-center justify-center rounded bg-zinc-700 text-[11px] leading-none font-bold text-white group-hover:flex"
    >
      +
    </button>
  );
};

/** POSTs `body` as JSON to `path` and answers with the error to show, if any. */
export const post = async (path: string, body?: unknown): Promise<string | undefined> => {
  const response = await fetch(path, {
    method: 'POST',
    ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }).catch(() => undefined);
  if (!response) return 'the hub could not be reached';
  if (response.ok) return;
  return (
    ((await response.json().catch(() => undefined)) as { error?: string } | undefined)?.error ?? `${response.status}`
  );
};

/** Says a review as one comment, its line comments listed under the body, and answers with the error to show, if any. */
const send = async (target: { pull: number } | { issue: number }, body: string, lines: LineDraft[]) => {
  const notes = lines.map(l => `- \`${l.path}:${l.line}\` ${l.body}`);
  const text = [body.trim(), notes.join('\n')].filter(Boolean).join('\n\n');
  if (!text) return 'write a comment';
  return post('/rpc/say', { ...target, text });
};

/**
 * The comment box at the bottom of a merge request or under a bot's question: a Markdown comment, sent with the line
 * comments collected for the review as one comment.
 */
const CommentBox = ({
  target,
  lines = [],
  onSent,
  placeholder = 'Leave a comment for the bot',
}: {
  target: { pull: number } | { issue: number };
  lines?: LineDraft[];
  onSent?: () => void;
  placeholder?: string;
}) => {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const submit = async () => {
    setSending(true);
    const failed = await send(target, body, lines);
    setSending(false);
    setError(failed);
    if (failed) return;
    setBody('');
    onSent?.();
  };
  return (
    <div className="space-y-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
      <Editor value={body} onChange={setBody} placeholder={placeholder} />
      <div className="flex flex-wrap items-center gap-2">
        {lines.length > 0 && (
          <span className="text-[11px] text-zinc-500">
            {lines.length} line {lines.length === 1 ? 'comment' : 'comments'} in this review
          </span>
        )}
        <Button variant="primary" className="ml-auto" disabled={sending} onClick={() => void submit()}>
          Comment
        </Button>
      </div>
      {error && <p className={cx('text-xs', accent.text)}>{error}</p>}
    </div>
  );
};

/** The answer to a run that blocked on its issue: a comment on the local issue, or a link to the issue on GitHub. */
export const AnswerBox = ({ run }: { run: Pick<Run, 'closure' | 'event'> }) => {
  const [sent, setSent] = useState(false);
  const { number, source, url } = run.event;
  if (run.closure !== 'blocked' || number === undefined) return null;
  if (source === 'github')
    return url ? (
      <a href={url} className="text-xs underline">
        Answer on GitHub
      </a>
    ) : null;
  return (
    <section className="space-y-1 pt-2">
      <h3 className="text-xs font-medium text-zinc-500">Answer on #{number}</h3>
      {sent ? (
        <p className="text-xs text-zinc-500">Sent; the bot picks it up from the issue.</p>
      ) : (
        <CommentBox target={{ issue: number }} placeholder="Answer the bot" onSent={() => setSent(true)} />
      )}
    </section>
  );
};

/** A merge request's line comments for the diff inside, and its thread and comment box after it. */
export const PullReview = ({
  pull,
  onSent,
  children,
}: {
  pull: { number: number; url: string; state: string; comments?: PullComment[] };
  onSent: () => void;
  children: ReactNode;
}) => {
  const [drafts, setDrafts] = useState<LineDraft[]>([]);
  const [writing, setWriting] = useState<string>();
  const posted = pull.comments ?? [];
  const comments = useMemo(() => {
    const byLine = new Map<string, PullComment[]>();
    for (const comment of posted)
      if (comment.path && comment.line !== undefined) {
        const key = keyOf(comment.path, comment.side ?? 'new', comment.line);
        byLine.set(key, [...(byLine.get(key) ?? []), comment]);
      }
    return byLine;
  }, [posted]);
  const github = pull.url.startsWith('http');
  const lines: Lines | undefined = github
    ? undefined
    : {
        comments,
        drafts,
        writing,
        has: (path, side, line) => {
          const key = keyOf(path, side, line);
          return comments.has(key) || writing === key || drafts.some(d => keyOf(d.path, d.side, d.line) === key);
        },
        open: (path, side, line) => setWriting(keyOf(path, side, line)),
        close: () => setWriting(undefined),
        add: draft => {
          setDrafts(d => [...d, draft]);
          setWriting(undefined);
        },
        remove: draft => setDrafts(d => d.filter(x => x !== draft)),
      };
  return (
    <LinesContext value={lines}>
      {children}
      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
          <Icon name="comment" className="size-3.5" />
          Comments
        </h3>
        <Thread comments={posted.filter(c => !c.path)} />
        {github ? (
          <a href={pull.url} className="text-xs underline">
            Comment on GitHub
          </a>
        ) : pull.state === 'open' ? (
          <CommentBox
            target={{ pull: pull.number }}
            lines={drafts}
            onSent={() => {
              setDrafts([]);
              onSent();
            }}
          />
        ) : (
          <p className="text-xs text-zinc-500">This merge request is {pull.state}; comments no longer start a bot.</p>
        )}
      </section>
    </LinesContext>
  );
};
