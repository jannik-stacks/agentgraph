import { z } from 'zod';
import { Association, type Trigger } from './schema.ts';
import type { GitHub, GitHubError } from './github-app.ts';
import type { BotEvent } from './types.ts';

const encoder = new TextEncoder();
const bytes = (body: string | Uint8Array) => (typeof body === 'string' ? encoder.encode(body) : body);

/** The `X-Hub-Signature-256` header value GitHub sends for `body`, an HMAC SHA-256 keyed with the webhook secret. */
export const sign = async (secret: string, body: string | Uint8Array): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(body) as Uint8Array<ArrayBuffer>));
  return 'sha256=' + Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
};

/** Checks a GitHub `X-Hub-Signature-256` header against the raw request body. Uses Web Crypto, so it runs on Node and Workers. */
export const verifySignature = async (
  secret: string,
  body: string | Uint8Array,
  header: string | null
): Promise<boolean> => {
  if (!secret || !header?.startsWith('sha256=')) return false;
  return timingSafeEqual(await sign(secret, body), header);
};

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const Associated = Association.catch('NONE');
const User = z.object({ login: z.string(), type: z.string().optional() });
const isBot = (user: z.infer<typeof User>) => user.type === 'Bot' || user.login.endsWith('[bot]');
const Repo = z.object({ full_name: z.string() });
const Item = z.object({ number: z.number(), html_url: z.string(), body: z.string().nullish(), user: User });

const Payload = z.object({
  action: z.string().optional(),
  repository: Repo,
  sender: User,
  comment: z
    .object({ body: z.string(), html_url: z.string(), user: User.optional(), author_association: Associated })
    .optional(),
  issue: Item.extend({ author_association: Associated, pull_request: z.object({}).nullish() }).optional(),
  pull_request: Item.extend({ author_association: Associated, base: z.object({ ref: z.string() }) }).optional(),
  review: z
    .object({
      body: z.string().nullish(),
      html_url: z.string(),
      user: User.optional(),
      author_association: Associated,
    })
    .optional(),
  ref: z.string().optional(),
  label: z.object({ name: z.string() }).optional(),
});

/** Webhook events `toEvent` maps; every other event name is ignored. */
export const handled: ReadonlySet<string> = new Set<string>([
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'workflow_dispatch',
]);

const hiddenText =
  /<!--[\s\S]*?(?:-->|$)|[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/**
 * Text as a reader sees it on GitHub: without HTML comments (an unclosed one hides the rest), zero-width, bidi and
 * other invisible format characters, or Unicode tag characters.
 */
export const visible = (text: string) => text.replace(hiddenText, '');

/**
 * Normalises a webhook delivery into a `BotEvent`, or `undefined` for events bothub does not handle. Events on a
 * pull request, including comments on it, carry its number as `pull` and its `refs/pull/<n>/head` ref, which also
 * covers forks. The actor is the sender, with the association of what it wrote; when it acted on someone else's issue
 * or pull request, such as a label, it is `NONE` until `senderTrust` looks it up. A bot sender is always `NONE`.
 * The body is the `visible` text, and the App's own mention `@<slug>` reads as `@bothub`.
 */
export const toEvent = (
  name: string,
  deliveryId: string,
  payload: unknown,
  now = new Date(),
  slug?: string
): BotEvent | undefined => {
  if (!handled.has(name)) return;
  const p = Payload.parse(payload);
  const item = p.pull_request ?? p.issue;
  const authored = p.comment ?? p.review ?? item;
  const url = authored?.html_url ?? item?.html_url;
  const pr = p.pull_request ?? (p.issue?.pull_request ? p.issue : undefined);
  const ref = pr ? `refs/pull/${pr.number}/head` : p.ref;
  const branch = p.pull_request?.base.ref ?? p.ref?.match(/^refs\/heads\/(.+)$/)?.[1];
  const writer = authored && 'user' in authored ? authored.user : undefined;
  const own = !writer || writer.login === p.sender.login;
  const association = isBot(p.sender) || !own ? 'NONE' : (authored?.author_association ?? 'NONE');
  const body = authored?.body == null ? undefined : mentioned(visible(authored.body), slug);
  return {
    id: deliveryId,
    ts: now.toISOString(),
    source: 'github',
    trigger: name as Trigger,
    ...(p.action && { action: p.action }),
    repo: p.repository.full_name,
    ...(item && { number: item.number }),
    actor: { login: p.sender.login, association },
    ...(body !== undefined && { body }),
    ...(url && { url }),
    ...(ref && { ref }),
    ...(branch && { branch }),
    ...(p.label && { label: p.label.name }),
    ...(pr && { pull: pr.number }),
  };
};

const mentioned = (body: string, slug?: string) =>
  slug && slug !== 'bothub'
    ? body.replace(new RegExp(`(^|\\s)@${slug}(?![\\w-])`, 'gi'), '$1@bothub')
    : body;

const writers = new Set(['admin', 'maintain', 'write']);

/**
 * The event with its sender trusted as a `COLLABORATOR` when the sender has write access to the repository, for an
 * actor `toEvent` left at `NONE`. Bots stay `NONE`; a failed lookup leaves the event as it is.
 */
export const senderTrust = async (event: BotEvent, gh: GitHub): Promise<BotEvent> => {
  const { login, association } = event.actor;
  if (association !== 'NONE' || login.endsWith('[bot]')) return event;
  const path = `/repos/${event.repo}/collaborators/${encodeURIComponent(login)}/permission`;
  const found = await gh<{ permission?: string; role_name?: string }>('GET', path).catch((e: GitHubError) => {
    if (e.status !== 404) console.error(`permission of ${login} on ${event.repo}: ${e.message}`);
    return undefined;
  });
  const trusted = [found?.role_name, found?.permission].some(role => role && writers.has(role));
  return trusted ? { ...event, actor: { login, association: 'COLLABORATOR' } } : event;
};
