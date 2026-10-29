import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request } from 'node:http';
import { pipeline } from 'node:stream/promises';

export const runFile = async (args: string[]) => {
  const [action, path, ...extra] = args;
  if (action !== 'put' || !path || extra.length) throw new Error('usage: agi file put <path>');
  try {
    const endpoint = process.env.AGENTGRAPH_TOOL_URL;
    const secret = process.env.AGENTGRAPH_TOOL_SECRET;
    if (!endpoint || !secret) throw new Error('file passing needs a local sandbox tool session');
    const url = new URL(`${endpoint}/files`);
    if (url.protocol !== 'http:') throw new Error('file passing needs the local session endpoint');
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error('expected a regular file');
      const signal = AbortSignal.timeout(30_000);
      const outgoing = request(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/octet-stream' },
        signal,
      });
      const result = new Promise<string>((resolve, reject) => {
        outgoing.once('error', reject);
        outgoing.once('response', incoming => {
          let text = '';
          incoming.on('error', reject);
          incoming.on('data', chunk => {
            text += chunk.toString();
            if (text.length > 2048) incoming.destroy(new Error('file response too large'));
          });
          incoming.on('end', () => {
            if (incoming.statusCode !== 201) reject(new Error(text || `file upload HTTP ${incoming.statusCode}`));
            else if (!/^file_[a-f0-9]{64}$/.test(text)) reject(new Error('invalid file handle response'));
            else resolve(text);
          });
        });
      });
      const [ref] = await Promise.all([
        result,
        pipeline(file.createReadStream({ autoClose: false }), outgoing, { signal }),
      ]);
      return ref;
    } finally {
      await file.close();
    }
  } catch (error) {
    throw new Error(`File ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
};
