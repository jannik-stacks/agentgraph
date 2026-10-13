import { atomWithRefresh, unwrap } from 'jotai/utils';

/** What the API server serves: its hub and data directories, where the data directory really is, and its process. */
export type Info = { hub: string; data: string; dataReal: string | null; pid: number; version: string };

const infoQueryAtom = atomWithRefresh(async (): Promise<Info | null> => {
  const response = await fetch('/api/info').catch(() => undefined);
  return response?.ok ? ((await response.json()) as Info) : null;
});

/** The API's `/api/info`, or null while it is loading or when the API does not answer. Writing refetches it. */
export const infoAtom = unwrap(infoQueryAtom, previous => previous ?? null);
export { infoQueryAtom as refreshInfoAtom };
