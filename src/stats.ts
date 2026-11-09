export const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

export const getMean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export const getQuantile = (xs: number[], q: number) => {
  const sorted = xs.toSorted((a, b) => a - b);
  const i = (sorted.length - 1) * q;
  const lo = sorted[Math.floor(i)] ?? 0;
  return lo + ((sorted[Math.ceil(i)] ?? lo) - lo) * (i - Math.floor(i));
};

export const getRounded = (n: number) => Math.round(n * 1000) / 1000;
