export const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

export const getMean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : undefined);

export const getQuantile = (xs: number[], q: number) => {
  if (!xs.length) return undefined;
  const sorted = xs.toSorted((a, b) => a - b);
  const i = (sorted.length - 1) * q;
  const lo = sorted[Math.floor(i)]!;
  return lo + (sorted[Math.ceil(i)]! - lo) * (i - Math.floor(i));
};

export const getRounded = (n: number) => Math.round(n * 1000) / 1000;

export const sumSpend = (parts: { usd?: number; unpriced?: string }[]) => {
  const unpriced = parts.find(p => p.unpriced !== undefined)?.unpriced;
  return { usd: sum(parts.map(p => p.usd ?? 0)), ...(unpriced !== undefined && { unpriced }) };
};
