import { handled, sign, toEvent, verifySignature } from './github.ts';
import type { Handler } from './api.ts';
import type { Fetch } from './github-app.ts';
import type { BotEvent } from './types.ts';

/** What a delivery carries besides its event: the raw event name and the app installation that sent it. */
export type Delivery = { name: string; installation?: number };

export type WebhookOptions = {
  secret: string;
  onEvent: (event: BotEvent, deliveryId: string, delivery: Delivery) => void | Promise<void>;
  onError?: (error: unknown, deliveryId: string) => void;
  /** Keeps the process alive for background work where the runtime needs it, such as a Worker's `ctx.waitUntil`. */
  waitUntil?: (work: Promise<unknown>) => void;
  maxBytes?: number;
  /** The App's slug, whose `@<slug>` mention reads as `@bothub`. */
  slug?: string;
};

/** GitHub caps webhook payloads at 25 MB; most are a few KB. */
export const defaultMaxBytes = 5 * 1024 * 1024;

const text = (status: number, body = '') => new Response(body || null, { status });

/** Reads at most `max` bytes of the body, or `undefined` when it is longer. */
const readLimited = async (req: Request, max: number): Promise<Uint8Array | undefined> => {
  const declared = Number(req.headers.get('content-length'));
  if (declared > max) return;
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const installationOf = (payload: unknown) => {
  const id = (payload as { installation?: { id?: unknown } } | null)?.installation?.id;
  return typeof id === 'number' ? id : undefined;
};

/**
 * A GitHub webhook receiver as a Web `Request` handler. Checks the signature over the raw body, maps the delivery to
 * a `BotEvent` and answers 202 before `onEvent` runs. Unhandled events get 204, bad signatures 401, bodies over
 * `maxBytes` 413 and malformed deliveries 400.
 */
export const webhook = ({
  secret,
  onEvent,
  onError = () => {},
  waitUntil,
  maxBytes = defaultMaxBytes,
  slug,
}: WebhookOptions): Handler => {
  if (!secret) throw new Error('a webhook secret is required');
  return async req => {
    if (req.method !== 'POST') return text(405);
    const body = await readLimited(req, maxBytes);
    if (!body) return text(413, 'payload too large');
    if (!(await verifySignature(secret, body, req.headers.get('x-hub-signature-256'))))
      return text(401, 'bad signature');
    const name = req.headers.get('x-github-event');
    const deliveryId = req.headers.get('x-github-delivery');
    if (!name || !deliveryId) return text(400, 'missing X-GitHub-Event or X-GitHub-Delivery');
    if (!handled.has(name)) return text(204);

    let payload: unknown;
    let event: BotEvent | undefined;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
      event = toEvent(name, deliveryId, payload, new Date(), slug);
    } catch {
      return text(400, 'malformed payload');
    }
    if (!event) return text(204);

    const installation = installationOf(payload);
    const delivery: Delivery = { name, ...(installation !== undefined && { installation }) };
    const work = Promise.resolve()
      .then(() => onEvent(event, deliveryId, delivery))
      .catch(e => onError(e, deliveryId));
    waitUntil?.(work);
    return text(202);
  };
};

/**
 * Signs a saved payload with the webhook secret and POSTs it the way GitHub would, so a local receiver can be tested
 * without GitHub. Resolves to the receiver's response.
 */
export const replay = async ({
  url,
  secret,
  event,
  payload,
  deliveryId = crypto.randomUUID(),
  fetch: fetcher = globalThis.fetch,
}: {
  url: string;
  secret: string;
  event: string;
  payload: string | Uint8Array;
  deliveryId?: string;
  fetch?: Fetch;
}): Promise<Response> =>
  fetcher(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GitHub-Hookshot/bothub-replay',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': deliveryId,
      'X-Hub-Signature-256': await sign(secret, payload),
    },
    body: payload as BodyInit,
  });
