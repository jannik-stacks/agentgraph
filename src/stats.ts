export const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

export const getMean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export const getRounded = (n: number) => Math.round(n * 1000) / 1000;
