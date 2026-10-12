export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A GitHub REST call: resolves to the parsed JSON body, throws a `GitHubError` on a non-2xx response. */
export type GitHub = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export type GitHubError = Error & { status: number };

export type AppCredentials = { appId: string | number; privateKey: string };

const api = 'https://api.github.com';
const encoder = new TextEncoder();

/** A REST client authenticated with `token` (an installation token or an app JWT). */
export const gh =
  (token: string, fetcher: Fetch = globalThis.fetch): GitHub =>
  async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetcher(api + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bothub',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      const message = `GitHub ${method} ${path} failed with ${res.status}: ${text.slice(0, 200)}`;
      throw Object.assign(new Error(message), { status: res.status }) satisfies GitHubError;
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };

const base64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const importKey = (pem: string) => {
  if (pem.includes('BEGIN RSA PRIVATE KEY'))
    throw new Error(
      'GitHub App private key is PKCS#1; convert it to PKCS#8 with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pkcs8.pem`'
    );
  const body = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem)?.[1];
  if (!body) throw new Error('GitHub App private key must be a PEM "BEGIN PRIVATE KEY" block');
  const der = Uint8Array.from(atob(body.replace(/\s+/g, '')), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
};

/** Signs a short-lived RS256 JWT that authenticates as the GitHub App. */
export const appJwt = async ({ appId, privateKey }: AppCredentials, now = Date.now()): Promise<string> => {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }));
  const input = `${header}.${claims}`;
  const key = await importKey(privateKey);
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input)));
  return `${input}.${base64url(signature)}`;
};

/** Issues installation tokens for a GitHub App, reusing each until a minute before it expires. */
export const githubApp = (
  credentials: AppCredentials,
  { fetch: fetcher = globalThis.fetch, now = Date.now }: { fetch?: Fetch; now?: () => number } = {}
) => {
  const cache = new Map<number, { token: string; expires: number }>();
  const installationToken = async (installationId: number): Promise<string> => {
    const cached = cache.get(installationId);
    if (cached && cached.expires - 60_000 > now()) return cached.token;
    const jwt = await appJwt(credentials, now());
    const { token, expires_at } = await gh(jwt, fetcher)<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${installationId}/access_tokens`
    );
    cache.set(installationId, { token, expires: Date.parse(expires_at) });
    return token;
  };
  return {
    installationToken,
    /** A REST client acting as the given installation, with a valid token on every request. */
    client:
      (installationId: number): GitHub =>
      async (method, path, body) =>
        gh(await installationToken(installationId), fetcher)(method, path, body),
  };
};
