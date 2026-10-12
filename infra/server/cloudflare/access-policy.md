# Access policy (not yet used)

Two hostnames:

| Hostname | Who | Protection |
|---|---|---|
| `hooks.bothub.example.com` | GitHub webhooks | No Access (GitHub cannot send its headers); the Worker checks `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET` and rejects anything else |
| `bothub.example.com` | studio and CLI API | Cloudflare Access application |

Access application for `bothub.example.com`:

- Identity provider: GitHub or Google.
- Allow policy: include "Emails ending in" `@example.com`. No other include rules.
- Session duration: 24 h.
- A second Allow policy with action "Service Auth" for one service token, used by the CLI
  (`CF-Access-Client-Id` and `CF-Access-Client-Secret`).
- The Worker also validates the `Cf-Access-Jwt-Assertion` header against the team's JWKS, so a
  request that bypasses Access (for example on a `workers.dev` URL) is refused. Disable
  `workers_dev` for this Worker.

Terraform (`cloudflare_zero_trust_access_application` and `_policy`) can own this later.
