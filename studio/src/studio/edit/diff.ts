export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

/** A line diff by longest common subsequence; hub files are small enough for the quadratic table. */
export const diffLines = (before: string, after: string): DiffLine[] => {
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after ? after.replace(/\n$/, '').split('\n') : [];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const lines: DiffLine[] = [];
  let [i, j] = [0, 0];
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: 'same', text: a[i++]! });
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) lines.push({ type: 'del', text: a[i++]! });
    else lines.push({ type: 'add', text: b[j++]! });
  }
  while (i < a.length) lines.push({ type: 'del', text: a[i++]! });
  while (j < b.length) lines.push({ type: 'add', text: b[j++]! });
  return lines;
};

/** Changed lines with `context` unchanged lines around them; runs of hidden lines become `null`. */
export const hunks = (lines: DiffLine[], context = 3): (DiffLine | null)[] => {
  const keep = lines.map((_, i) =>
    lines.slice(Math.max(0, i - context), i + context + 1).some(line => line.type !== 'same')
  );
  const out: (DiffLine | null)[] = [];
  lines.forEach((line, i) => {
    if (keep[i]) out.push(line);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
};
