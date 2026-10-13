import { useEffect, useState } from 'react';
import type { ApiBuild } from '../../src/api.ts';
import { usePolling } from './ui.tsx';

/** Whether the API answers with code older than its source; an API without `/api/build` is older still. */
export const isStale = async (get: typeof fetch = fetch) => {
  const response = await get('/api/build');
  if (response.status === 404) return true;
  if (!response.ok) return false;
  return ((await response.json()) as ApiBuild).stale;
};

/** A banner shown while the API server runs older code than `src/`. */
export const StaleApi = ({ everyMs = 3000 }: { everyMs?: number }) => {
  const [stale, setStale] = useState(false);
  const poll = () => void isStale().then(setStale, () => {});
  useEffect(poll, []);
  usePolling(poll, everyMs);
  if (!stale) return null;
  return (
    <p role="alert" className="bg-amber-100 px-4 py-1.5 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      The API is out of date with <code>src/</code>. <code>npm run dev</code> restarts it on its own; if this stays,
      restart the dev server.
    </p>
  );
};
