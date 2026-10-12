# GitHub App for bothub

GitHub mode runs the same workflows as local mode, with events coming from a GitHub App webhook
instead of `issues/*.md`. `bothub webhook serve` listens on two ports on 127.0.0.1:

| Port | What | Exposed |
|---|---|---|
| 5182 | webhook receiver (signature checked, nothing else served) | yes, through a tunnel |
| 5181 | studio API | no, localhost only |

Everything below uses placeholders (`YOUR-USER`, `bothub-sandbox`, `hooks-dev.example.com`).
Secrets live in the data directory (`~/.bothub` or `$BOTHUB_DATA`), never in this repository.

## Files

- `app-manifest.json`: the app definition. Permissions: contents, issues and pull requests
  read and write, metadata read. Events: issues, issue comments, pull requests, pull request
  reviews and review comments, pushes.
- `create-app.html`: a small page that posts the manifest to GitHub (the manifest flow) and
  shows the command that exchanges the returned code for the app's credentials.

## Setup

1. **Test repository.** Create a private repository such as `acme/sandbox` with one
   commit on `main`. Keep the app installed only there while testing.

2. **Tunnel.** Start one (see below) so you know the public webhook URL.

3. **Edit the manifest.** In `app-manifest.json`, set `name` (app names are global on GitHub)
   and `hook_attributes.url` to the tunnel URL. Leave `redirect_url` as is.

4. **Create the app.** Serve this directory and open the page:

   ```sh
   python3 -m http.server 8000 --bind 127.0.0.1 -d infra/github
   open http://localhost:8000/create-app.html
   ```

   Click "Create on GitHub", confirm on GitHub, and you land back on the page with a command.
   Run it within an hour; it writes `~/.bothub/github-app.json` with the app id, private key and
   webhook secret:

   ```sh
   (umask 077; curl -fsS -X POST https://api.github.com/app-manifests/CODE/conversions > ~/.bothub/github-app.json)
   ```

5. **Private key.** GitHub hands out a PKCS#1 key; bothub signs with Web Crypto, which needs
   PKCS#8. Convert it and drop the original:

   ```sh
   cd ~/.bothub
   jq -r .pem github-app.json > github-app.pkcs1.pem
   openssl pkcs8 -topk8 -nocrypt -in github-app.pkcs1.pem -out github-app.pem
   chmod 600 github-app.pem
   rm github-app.pkcs1.pem
   ```

6. **Environment.** Append to `~/.bothub/.env`, then delete the JSON:

   ```sh
   cd ~/.bothub
   echo "BOTHUB_APP_ID=$(jq -r .id github-app.json)" >> .env
   echo "BOTHUB_APP_KEY_FILE=$HOME/.bothub/github-app.pem" >> .env
   echo "BOTHUB_WEBHOOK_SECRET=$(jq -r .webhook_secret github-app.json)" >> .env
   chmod 600 .env
   jq -r .html_url github-app.json   # note the app page, then:
   rm github-app.json
   ```

   If `webhook_secret` came back empty, generate one (`openssl rand -hex 32`), put it in `.env` and
   paste it under the app's settings, Webhook secret.

7. **Install.** Open `<app page>/installations/new`, choose "Only select repositories" and pick
   the test repository. The installation id is the number at the end of the URL you land on;
   `bothub webhook serve` reads it from each delivery, `bothub run` needs it as
   `BOTHUB_INSTALLATION_ID` in `.env`.

8. **Hub.** Use a hub whose `hub.yaml` has `issues: github` (the default).

9. **Serve.**

   ```sh
   bothub webhook serve --hub path/to/hub --repo acme/sandbox
   ```

   `--repo` is an allowlist; deliveries from other repositories are acknowledged and ignored.

10. **Check the wiring without GitHub.** Replay a saved payload signed with your secret:

    ```sh
    bothub webhook replay payload.json --event issue_comment
    ```

    It prints the receiver's status: 202 accepted, 200 already seen, 204 not an event bothub
    handles, 401 bad signature. Any payload from the app's "Recent Deliveries" page works as a
    file; give each replay a new `--delivery` id or it is acknowledged as a repeat.

11. **End to end.** Comment `/bothub <task>` on an issue in the test repository as its owner. The
    app's Advanced tab lists every delivery with the response bothub gave and a redeliver button.

## Local webhook delivery

| | smee.io | cloudflared |
|---|---|---|
| Account | none | none for a quick tunnel, a Cloudflare zone for a fixed hostname |
| URL | fixed per channel | quick tunnel: new random URL on every start; named tunnel: fixed |
| Path | GitHub to smee.io, then a client on your machine pulls and re-posts | GitHub to Cloudflare's edge, then through an outbound connection to your port |
| Privacy | anyone with the channel URL can read the payloads | only your service sees them |
| Signatures | the client re-posts the JSON; if deliveries fail with 401 through smee but pass with replay, the body was re-encoded | raw bytes pass through untouched |
| Later | dev only | the same tunnel fronts the VPS in milestone 5 (`infra/server`) |

Use **cloudflared**. It forwards the request unchanged, keeps payloads off a shared relay, and a
named tunnel is the same piece that later puts a server behind Cloudflare with no open port.
smee is fine for a five-minute try without any account.

### cloudflared quick tunnel

```sh
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:5182
```

It prints `https://<random>.trycloudflare.com`. Put that URL in the app's settings under
Webhook URL; it changes every time the tunnel restarts.

### cloudflared named tunnel

Needs a domain on Cloudflare. Once:

```sh
cloudflared tunnel login
cloudflared tunnel create bothub-dev
cloudflared tunnel route dns bothub-dev hooks-dev.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: bothub-dev
credentials-file: /Users/YOUR-USER/.cloudflared/TUNNEL-ID.json
ingress:
  - hostname: hooks-dev.example.com
    service: http://127.0.0.1:5182
  - service: http_status:404
```

Then, each session:

```sh
cloudflared tunnel run bothub-dev
```

The webhook URL stays `https://hooks-dev.example.com/`. Only port 5182 is routed; never point a
tunnel at the studio port.

### smee.io

Open https://smee.io/new for a channel URL, put it in the app's Webhook URL, then:

```sh
npx smee-client --url https://smee.io/CHANNEL --target http://127.0.0.1:5182/
```
