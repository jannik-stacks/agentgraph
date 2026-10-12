import { useEffect, useEffectEvent, useState } from 'react';
import type { EventRecord } from '../../../src/store.ts';

type Stream = { records: EventRecord[]; done: boolean; error: boolean };

/** Tails a run's events over Server-Sent Events until the server sends `end`. Key the caller by run id. */
export const useEventStream = (runId: string, onEnd: () => void) => {
  const [stream, setStream] = useState<Stream>({ records: [], done: false, error: false });
  const ended = useEffectEvent(onEnd);

  useEffect(() => {
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    let buffer: EventRecord[] = [];
    let frame = 0;
    const flush = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      setStream(s => ({ ...s, records: [...s.records, ...batch], error: false }));
    };
    source.onmessage = message => {
      buffer.push(JSON.parse(message.data as string) as EventRecord);
      frame ||= requestAnimationFrame(flush);
    };
    source.addEventListener('end', () => {
      source.close();
      flush();
      setStream(s => ({ ...s, done: true }));
      ended();
    });
    source.onerror = () => setStream(s => ({ ...s, error: source.readyState !== EventSource.OPEN }));
    return () => {
      source.close();
      cancelAnimationFrame(frame);
    };
  }, [runId]);

  return stream;
};
