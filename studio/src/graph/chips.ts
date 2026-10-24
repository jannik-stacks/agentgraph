import type { Graph } from '../../../src/graph.ts';

export type Chip = {
  glyph?: 'hand' | 'stop' | 'checks' | 'agent' | 'writes' | 'traces' | 'aside' | 'each';
  label: string;
  count?: number;
  tip: string;
};

export const getStepDoerKind = (doer: string) => (doer === 'script' || doer === 'human' ? doer : 'agent');

/** The badges a step shows under its name, in the order they read. */
export const makeStepChips = (node: Graph['nodes'][number]): Chip[] => {
  const chips: Chip[] = [];
  const n = node.checks.length;
  const judges = [...new Set(node.checks.flatMap(c => c.agent ?? []))];
  const readers = [...(node.traces ? [node.doer] : []), ...node.checks.filter(c => c.traces).map(c => c.agent)];
  if (getStepDoerKind(node.doer) === 'human')
    chips.push({
      glyph: 'hand',
      label: 'you decide',
      tip: 'Waits for you. Approve or merge to go on; request changes to send it back.',
    });
  for (const c of node.checks.filter(c => c.mode === 'stop'))
    chips.push({ glyph: 'stop', label: c.name, tip: `If ${c.name} fails, the run stops at once.` });
  if (n > 0)
    chips.push({
      glyph: 'checks',
      label: n === 1 ? 'check' : 'checks',
      count: n,
      tip: `${n === 1 ? 'One check runs' : `${n} checks run`} after each try: ${node.checks.map(c => c.name).join(', ')}.`,
    });
  if (judges.length > 1)
    chips.push({
      glyph: 'agent',
      label: 'reviewers',
      count: judges.length,
      tip: `${judges.join(' and ')} review each try side by side, each in its own session. Their findings go back together.`,
    });
  if (node.model !== undefined) {
    const agent = node.doer.split(' / ')[0]!;
    chips.push({
      glyph: 'agent',
      label: node.model,
      tip: `${agent} runs on the model alias ${node.model}, which the proxy maps to a model. Set by model in agents/${agent}.md.`,
    });
  }
  if (node.writes?.length) {
    const agent = node.doer.split(' / ')[0]!;
    chips.push({
      glyph: 'writes',
      label: node.writes.map(k => (k === 'pull_request' ? 'pr' : k)).join(' '),
      tip: `${agent} can write to GitHub: ${node.writes.join(', ')}. The engine refuses anything else. Set by returns in agents/${agent}.md.`,
    });
  }
  if (readers.length > 0)
    chips.push({
      glyph: 'traces',
      label: 'reads traces',
      tip: `${readers.join(' and ')} read the traces of the runs on the issue: each session's prompt, thinking, tool calls and replies, not only the change.`,
    });
  if (node.asides)
    chips.push({
      glyph: 'aside',
      label: 'answers asides',
      tip: "A plain comment or question here is answered by a fork of the earlier step's session, in your thread; the run keeps waiting.",
    });
  if (node.each !== undefined) {
    const unit = node.each === 'hunks' || node.each === 'files' ? node.each.slice(0, -1) : undefined;
    chips.push({
      glyph: 'each',
      label: `each ${unit ?? 'item'}`,
      tip: unit
        ? `Runs once per ${unit}, each in a fresh session.`
        : `Runs once per line that ${node.each} prints, each in a fresh session.`,
    });
  }
  return chips;
};

/** Width of a chip in 10px mono: border, padding, glyph and gap, then one advance per character. */
const chipWidth = (chip: Chip) =>
  8 + (chip.glyph ? 16 : 0) + chip.label.length * 6.1 + (chip.count === undefined ? 0 : 4);
const chipGap = 6;
const maxLines = 3;

/** The chips packed into lines of `width`, at most three; what does not fit becomes a last "+N more" chip. */
export const splitStepChipsIntoRows = (chips: Chip[], width: number): Chip[][] => {
  const lines: Chip[][] = [];
  let used = Infinity;
  for (const [i, chip] of chips.entries()) {
    const w = chipWidth(chip);
    if (used + chipGap + w <= width) {
      lines.at(-1)!.push(chip);
      used += chipGap + w;
      continue;
    }
    if (lines.length === maxLines) {
      const last = lines.at(-1)!;
      const rest = chips.slice(i);
      const more = () => ({
        label: `+${rest.length} more`,
        tip: `Also ${rest.map(c => (c.count === undefined ? c.label : `${c.count} ${c.label}`)).join(', ')}.`,
      });
      while (last.length > 1 && last.reduce((sum, c) => sum + chipWidth(c) + chipGap, chipWidth(more())) > width)
        rest.unshift(last.pop()!);
      last.push(more());
      break;
    }
    lines.push([chip]);
    used = w;
  }
  return lines;
};
