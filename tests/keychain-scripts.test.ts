import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const scripts = join(import.meta.dirname, '..', 'infra', 'github');
const pem = '-----BEGIN RSA PRIVATE KEY-----\nFAKE-canary\n-----END RSA PRIVATE KEY-----\n';

const security = `#!/bin/sh
echo "$*" >> "$CALLS"
store="$KEYCHAIN/item"
case "$1" in
  -i) sed -n 's/.* -w \\([^ ]*\\)$/\\1/p' > "$store";;
  find-generic-password) [ -f "$store" ] || exit 44; case " $* " in *" -w "*) cat "$store";; esac;;
esac
`;

describe('keychain scripts', () => {
  it('moves key.pem into the Keychain, then hands the key to run.ts on fd 3 only', () => {
    const dir = tmp('keychain');
    write(dir, {
      'config/acme/key.pem': pem,
      'config/acme/app.env': `AGENTGRAPH_APP_ID=7\nAGENTGRAPH_APP_KEY_FILE=${join(dir, 'config/acme/key.pem')}\n`,
      'bin/security': security,
      'bin/node': '#!/bin/sh\necho "args $*"\ncat /dev/fd/3\n',
    });
    for (const tool of ['security', 'node']) chmodSync(join(dir, 'bin', tool), 0o755);
    const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CALLS: join(dir, 'calls'), KEYCHAIN: dir };

    const imported = execFileSync('bash', [join(scripts, 'keychain-import.sh'), 'acme', join(dir, 'config')], {
      encoding: 'utf8',
      env,
    });
    expect(imported).toContain('npm run with-key -- acme loop');
    expect(existsSync(join(dir, 'config/acme/key.pem'))).toBe(false);
    expect(readFileSync(join(dir, 'config/acme/app.env'), 'utf8')).toBe(
      'AGENTGRAPH_APP_ID=7\nAGENTGRAPH_APP_KEY_FILE=/dev/fd/3\n'
    );
    expect(statSync(join(dir, 'config/acme/app.env')).mode & 0o777).toBe(0o600);

    const ran = execFileSync('bash', [join(scripts, 'with-key.sh'), 'acme', 'loop', '--data', 'runs'], {
      encoding: 'utf8',
      env,
    });
    expect(ran).toMatch(/^args \S+\/bin\/run\.ts loop --data runs\n/);
    expect(ran).toContain(pem);
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    expect(calls).not.toContain('FAKE-canary');
    expect(calls).not.toContain(Buffer.from(pem).toString('base64').slice(0, 24));
  });

  it('keeps key.pem when the Keychain holds another value', () => {
    const dir = tmp('keychain-refused');
    write(dir, {
      'config/acme/key.pem': pem,
      'config/acme/app.env': 'AGENTGRAPH_APP_ID=7\n',
      item: 'b2xk',
      'bin/security': '#!/bin/sh\n[ "$1" = -i ] && exit 0\ncat "$KEYCHAIN/item"\n',
    });
    chmodSync(join(dir, 'bin', 'security'), 0o755);
    const r = spawnSync('bash', [join(scripts, 'keychain-import.sh'), 'acme', join(dir, 'config')], {
      encoding: 'utf8',
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, KEYCHAIN: dir },
    });
    expect(r.status).toBe(1);
    expect(readFileSync(join(dir, 'config/acme/key.pem'), 'utf8')).toBe(pem);
  });
});
