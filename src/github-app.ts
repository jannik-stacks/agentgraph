import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A GitHub REST call: resolves to the parsed JSON body, throws a `GitHubError` on a non-2xx response. */
export type GitHub = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export type GitHubError = Error & { status: number };

export type AppCredentials = { appId: string | number; privateKey: string };

const api = 'https://api.github.com';

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

const base64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

const rsaKey = (pem: string): KeyObject => {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('GitHub App private key must be a PEM private key');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('GitHub App private key must be an RSA key');
  return key;
};

/** Signs a short-lived RS256 JWT that authenticates as the GitHub App. Takes the PKCS#1 key GitHub hands out, or PKCS#8. */
export const appJwt = async ({ appId, privateKey }: AppCredentials, now = Date.now()): Promise<string> => {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }));
  const input = `${header}.${claims}`;
  return `${input}.${base64url(sign('sha256', Buffer.from(input), rsaKey(privateKey)))}`;
};

/** Issues installation tokens for a GitHub App, reusing each until a minute before it expires. */
export const githubApp = (
  credentials: AppCredentials,
  { fetch: fetcher = globalThis.fetch, now = Date.now }: { fetch?: Fetch; now?: () => number } = {}
) => {
  const cache = new Map<number, Promise<{ token: string; expires: number }>>();
  const mint = async (installationId: number) => {
    const jwt = await appJwt(credentials, now());
    const { token, expires_at } = await gh(jwt, fetcher)<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${installationId}/access_tokens`
    );
    return { token, expires: Date.parse(expires_at) };
  };
  const installationToken = async (installationId: number): Promise<string> => {
    const cached = await cache.get(installationId)?.catch(() => undefined);
    if (cached && cached.expires - 60_000 > now()) return cached.token;
    const minted = mint(installationId);
    cache.set(installationId, minted);
    return (await minted).token;
  };
  const installations = new Map<string, Promise<number>>();
  const installation = (repo: string): Promise<number> => {
    const known = installations.get(repo);
    if (known) return known;
    const found = appJwt(credentials, now())
      .then(jwt => gh(jwt, fetcher)<{ id: number }>('GET', `/repos/${repo}/installation`))
      .then(({ id }) => id);
    installations.set(repo, found);
    found.catch(() => installations.delete(repo));
    return found;
  };
  const client =
    (installationId: number): GitHub =>
    async (method, path, body) =>
      gh(await installationToken(installationId), fetcher)(method, path, body);
  return {
    installationToken,
    /** A REST client acting as the given installation, with a valid token on every request. */
    client,
    /** The id of the installation that covers `repo`, looked up once per repository. */
    installation,
    /** A REST client acting as whichever installation covers `repo`. */
    repoClient:
      (repo: string): GitHub =>
      async (method, path, body) =>
        client(await installation(repo))(method, path, body),
    /** An installation token for `repo`, for git over HTTPS. */
    repoToken: async (repo: string) => installationToken(await installation(repo)),
  };
};
