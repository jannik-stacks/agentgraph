import type { EventRecord } from '../../../../src/store.ts';
import type { AgentEvent } from '../../../../src/types.ts';
import { Icon } from '../../icons.tsx';
import { Tooltip } from '../../ui.tsx';
import { formatTokens } from '../bits.tsx';

type Recall = Extract<AgentEvent, { type: 'recall' }>;
type Item = Recall['items'][number];

/** The surfacer's recall events of a run, in order. */
export const recallsOf = (records: EventRecord[]) =>
  records.flatMap(({ seq, event }) => (event.type === 'recall' ? [{ seq, event }] : []));

const shown = (item: Item) => item.fate === 'surfaced' || item.fate === 'returned';

const fateText: Record<Item['fate'], string> = {
  surfaced: 'surfaced',
  returned: 'returned',
  cutoff: 'below the cutoff',
  budget: 'over the token budget',
  unjudged: 'not judged, so not surfaced',
};

const score = (item: Item) =>
  item.p !== undefined ? item.p.toFixed(2) : item.score !== undefined ? item.score.toFixed(1) : undefined;

const scoreTip = (item: Item) =>
  [
    item.p !== undefined && `Relevance by the decision model: ${item.p.toFixed(3)}`,
    item.score !== undefined && `Search score (BM25): ${item.score.toFixed(2)}`,
  ]
    .filter(Boolean)
    .join('\n');

const trigger = (event: Recall) =>
  `${event.on === 'turn' ? 'Before a model turn, for' : 'history tool call with'}: ${event.query || '(empty query)'}`;

const ItemIcon = ({ item }: { item: Item }) =>
  item.kind === 'note' ? (
    <Icon name="file" className="size-3 text-zinc-400" />
  ) : (
    <Icon name={item.kind === 'run' || item.kind === 'summary' ? 'time' : 'file'} className="size-3 text-zinc-400" />
  );

const kindTip = (item: Item) =>
  item.kind === 'note'
    ? 'Hub note'
    : item.kind === 'summary'
      ? 'Earlier-run summary'
      : item.kind === 'run'
        ? 'Earlier run'
        : 'Item';

const Tokens = ({ n, tip }: { n: number; tip: string }) => (
  <Tooltip tip={tip}>
    <span className="text-zinc-500 tabular-nums">{formatTokens(n)} in</span>
  </Tooltip>
);

/** Totals for the step head: items shown to the bot and the tokens they added. */
const recallTotals = (recalls: { event: Recall }[]) => ({
  items: recalls.reduce((n, r) => n + r.event.items.filter(shown).length, 0),
  tokens: recalls.reduce((n, r) => n + r.event.tokens, 0),
});

export const RecalledHead = ({ recalls }: { recalls: { event: Recall }[] }) => {
  const { items, tokens } = recallTotals(recalls);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Tooltip tip="What the memory surfacer gave the bot: hub notes and earlier-run summaries, and history tool results">
        <Icon name="file" className="size-3 text-zinc-400" />
      </Tooltip>
      <span className="text-zinc-700 dark:text-zinc-300">Recalled</span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <Tooltip tip={`${items} items over ${recalls.length} ${recalls.length === 1 ? 'lookup' : 'lookups'}`}>
          <span className="text-zinc-500 tabular-nums">{items} items</span>
        </Tooltip>
        <Tokens n={tokens} tip={`About ${tokens.toLocaleString()} tokens added to the bot's context`} />
      </span>
    </span>
  );
};

/** One row per item the surfacer showed the bot, then a row naming what each lookup left out. */
export const RecalledRows = ({ recalls }: { recalls: { seq: number; event: Recall }[] }) => (
  <ul className="space-y-0.5 py-1 pr-2 text-xs">
    {recalls.flatMap(({ seq, event }) => {
      const cut = event.items.filter(i => !shown(i));
      const rows = event.items.filter(shown).map(item => (
        <li key={`${seq}:${item.pointer}`} className="flex min-w-0 items-center gap-2 py-0.5">
          <Tooltip tip={kindTip(item)}>
            <ItemIcon item={item} />
          </Tooltip>
          <Tooltip tip={trigger(event)} className="min-w-0 flex-1">
            <span className="min-w-0 truncate">
              <span className="font-mono">{item.pointer}</span>
              {item.title && item.kind === 'note' && <span className="ml-2 text-zinc-500">{item.title}</span>}
            </span>
          </Tooltip>
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {score(item) !== undefined && (
              <Tooltip tip={scoreTip(item)}>
                <span className="text-zinc-500 tabular-nums">{score(item)}</span>
              </Tooltip>
            )}
            {item.tokens !== undefined && (
              <Tokens n={item.tokens} tip={`About ${item.tokens.toLocaleString()} tokens added`} />
            )}
          </span>
        </li>
      ));
      const left =
        cut.length || event.error || !event.items.length ? (
          <li key={`${seq}:cut`} className="flex min-w-0 items-center gap-2 py-0.5 text-zinc-500">
            <Tooltip
              tip={[
                trigger(event),
                event.error && `Decision model unavailable: ${event.error}`,
                ...cut.map(i => `${i.pointer}${score(i) ? ` ${score(i)}` : ''}: ${fateText[i.fate]}`),
              ]
                .filter(Boolean)
                .join('\n')}
              className="min-w-0 flex-1"
            >
              <span className="min-w-0 truncate">
                {event.items.length
                  ? `${cut.length} left out${event.error ? ', decision model unavailable' : ''}`
                  : `nothing matched ${event.on === 'turn' ? 'the turn' : 'the history query'}`}
              </span>
            </Tooltip>
          </li>
        ) : null;
      return left ? [...rows, left] : rows;
    })}
  </ul>
);
