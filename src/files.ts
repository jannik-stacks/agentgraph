import { randomBytes } from 'node:crypto';
import type { ToolContext } from './plugin.ts';

export const makeFiles = (
  trace: (
    action: 'put' | 'read',
    ref: string,
    bytes: number,
    type: Awaited<ReturnType<ToolContext['readFile']>>['type']
  ) => Promise<void>
) => {
  const files = new Map<string, Awaited<ReturnType<ToolContext['readFile']>>>();
  let pending = 0;
  let total = 0;
  let received = 0;
  let closed = false;
  const read = async (ref: string, signal: AbortSignal) => {
    try {
      signal.throwIfAborted();
      const file = files.get(ref);
      if (closed || !file) throw new Error('unknown, expired or outside this session');
      await trace('read', ref, file.bytes.length, file.type);
      signal.throwIfAborted();
      if (closed) throw new Error('session closed');
      return { ...file, bytes: new Uint8Array(file.bytes) };
    } catch (error) {
      throw new Error(`File ${ref}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  return {
    read,
    put: async (source: AsyncIterable<Uint8Array>, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (closed) throw new Error('File upload: session closed');
      if (pending >= 2) throw new Error('File upload: concurrent upload limit reached');
      if (files.size + pending >= 32) throw new Error('File upload: session count limit reached');
      pending++;
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of source) {
          signal.throwIfAborted();
          size += chunk.length;
          received += chunk.length;
          if (size > 10 * 1024 * 1024) throw new Error('File upload: exceeds 10 MiB');
          if (received > 256 * 1024 * 1024) throw new Error('File upload: session input byte limit reached');
          chunks.push(new Uint8Array(chunk));
        }
        signal.throwIfAborted();
        if (closed) throw new Error('File upload: session closed');
        const bytes = Buffer.concat(chunks);
        const type = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          ? 'image/png'
          : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
            ? 'image/jpeg'
            : undefined;
        if (!type) throw new Error('File upload: expected PNG or JPEG magic bytes');
        if (total + size > 64 * 1024 * 1024) throw new Error('File upload: session byte limit reached');
        const ref = `file_${randomBytes(32).toString('hex')}`;
        total += size;
        try {
          await trace('put', ref, size, type);
          signal.throwIfAborted();
          if (closed) throw new Error('File upload: session closed');
          files.set(ref, { bytes, type });
          return ref;
        } catch (error) {
          if (!closed) total -= size;
          throw error;
        }
      } finally {
        pending--;
      }
    },
    close: () => {
      closed = true;
      files.clear();
      total = 0;
    },
  };
};
