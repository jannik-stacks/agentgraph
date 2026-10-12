import { useEffect, useEffectEvent, useState } from 'react';
import type { EventRecord } from '../../../src/store.ts';

type Stream = { records: EventRecord[]; done: boolean; error: boolean };

/** Tails a run's events over Server-Sent Events until the server sends `end`. Key the caller by run id. */
export const useEventStream = (runId: string, onEnd: () => void) => {
  const [stream, setStream] = useState<Stream>({ records: [], done: false, error: false });
  const ended = useEffectEvent(onEnd);

  useEffect(() => {
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    source.onmessage = message => {
      const record = JSON.parse(message.data as string) as EventRecord;
      setStream(s => ({ ...s, records: [...s.records, record], error: false }));
    };
    source.addEventListener('end', () => {
      source.close();
      setStream(s => ({ ...s, done: true }));
      ended();
    });
    source.onerror = () => setStream(s => ({ ...s, error: source.readyState !== EventSource.OPEN }));
    return () => source.close();
  }, [runId]);

  return stream;
};
