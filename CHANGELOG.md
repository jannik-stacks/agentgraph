# Changelog

## 0.0.3

### Patch Changes

- 293ab7d: `agi import <commit>|<patch> [<issue file>]` keeps a change made elsewhere as an ended run with no issue, so `check --runs` can score it beside the agents' runs. Every import is a new run; `--meta` keeps JSON as the origin input to pair runs by.
- deb117a: A change asked of a run waiting at a human step goes back to work even when the reply could not be posted, and a reply under a review thread now goes to the pull request, not its issue.
- d8f45ea: The aside grant test reads the tracker folder, renamed from forge.
- 452cebd: Every attempt's files are committed at `refs/agentgraph/attempts/<run id>/<n>`, so a retry never overwrites an earlier try. A runner now saves a dead runner's checkout at `refs/agentgraph/reaped/<id>` before removing it, and keeps it when the save fails.
- 50e8d82: The bench sidebar has searchable checkbox dropdowns for Filter and Group points by, with help beside each heading and scroll fades only where supported and overflowing.

  Infra shows matching failure counts, reasons and run links even when those runs are excluded from scores.

  Separate sidebar sections with evenly spaced dividers and add a quick "only" action to Filter and Group points by choices.

  Keep saved bench filters and grouping selections correct when label values disappear, and use native popover search focus.

- 32c1bd1: A bench run's trace keeps its data dir for full logs, results and links, and the studio serves a data dir only when its real path, after symlinks, is inside a bench dir.
- 4abdc3a: Show bench points as rows grouped by case set, with label columns, each case's mean over its repeats behind the point's mean, median and middle half, hidden tests as a share, cost as mean ± spread and time in s, min or h, and link every run to its trace with `/runs/<id>?data=<arm data dir>`. Points never merge across case sets, intervals show from 10 cases on, the frontier shows for one case set, axes use real minus signs and cost labels no longer overlap. Points are named by the labels picked under names, and labels that would overlap are moved with a leader line or hidden.
- 57ffa2b: Recover unavailable bench axes with a visible cost fallback. Measure graph copies without a tree id and skip missing git objects without fetching.
- ca97520: The bench report and the studio Bench page read a judged case again after the judge writes its panel marker.
- 886408d: The bench driver reads its keys once before it checks every queued point, so proxy keys given only in the shell reach each point.
- 0357a94: Expose flat bench labels, free run labels and repository setup labels. Filter, group and colour Studio bench points by any label, including existing runs.
- 06ea59d: `bench run` labels every run it starts (case, arm, harness, model, repeat, engine, set) and the driver finds finished jobs by their scores and `judge/panel.json` instead of `done/` markers. A reused cached arm takes the new invocation's labels.
- ee8137f: `node bench/migrate.ts <old bench dir> <set>` copies a bench dir in the earlier `diff.patch` and `score.json` layout into run slots. Its results are recorded at version `migrated`, and the old dir is left untouched.
- 3049bbb: The studio serves Bench as a built-in page plugin at `/bench`, registered only when it starts with `--bench` dirs, and drops `/api/bench`. The header lists Inbox, Graph, Runs, then every page plugin, then Docs. Results no longer has a Benchmarks source.
- b6389eb: The bench driver refuses an engine that is not at its SHA or has changes, and checks every point's list price and proxy key before it starts a job. Logs, reports and done markers are named by harness and model, score trees are removed at the end, and an unreachable Docker daemon is no longer reported as a missing image.
- 21522a9: Record fixed free labels on bench points with LABELS=key=value.
- a9b3870: The bench is a view over runs. Each case, arm, repeat, point and graph has a slot in `<set>/runs/` with numbered attempts. The `human` and `base` references are imported runs, and scores and judges are `bench/*` results in a run's `checks.jsonl`. `bench/start-runs.ts` replaces `bench/drive.ts` and skips units already on disk. The `report`, `status` and `resume` commands, the `.cache` and `.attic` dirs, and the `BENCH_ENGINE`, `BENCH_DIR`, `BENCH_CACHE` and `BENCH_EXCLUDE` variables are gone. `--max-codex` is now an absolute weekly percent (default 90).
- 772f2ca: Discover numeric bench axes only from scoring rows. Keep graph copy measurements local to their run so tree recovery uses Git counts.
- 0f840c4: Bench rows show the run median and range next to the case median and middle half, so repeats that vary within a case stay visible, and a point's runs stay apart when two arms share a case and repeat.
- 4e402a1: Keep the bench page and tune scores working when a run has nothing to score, such as a case skipped for lack of tests.
- d1ded3c: `examples/board` ships a board plugin that sets single-select fields of an issue's card on a GitHub project, such as Status, to the options mapped from its status label, and clears a field with no option for it.
- e87b3e1: Report graph loading and session refresh failures instead of silently dropping them.
- d74f0e2: A browser sandbox image, `infra/local/sandbox/browser`, adds Playwright's headless Chromium so graphs can run browser end-to-end tests with no network. A graph opts in with `image: agentgraph-sandbox:browser`.
- dff9370: A base that neither the default branch nor a workflow `base` branch reaches builds its own environment and never writes the repo's cache volume; its cache writes stay in that environment's own volume. A build while a checkout overlays the cache does the same, and checkouts no longer start while a build writes the cache. Every environment build starts from a fresh lower volume, and build containers are removed before their volumes.
- 7fcfbd4: Share GitHub polling across issues and retain installation tokens and conditional caches between loop passes. Wait for rate-limit resets before sending more requests.
- 38c762d: Catch-up runs the graph's setup on the pull request's files instead of trusting the base checkout's installed dependencies.
- 2bdad12: The chatgpt provider now serves opencode and pi too. Agents run gpt-6.1-sol, and `fast` runs gpt-6-luna.
- 3d65cd4: Report a check's exit 127 as a failed check unless its own command is missing.
- 0b25d66: Clean up landed runs' local engine checkouts and branches with one bounded PR lookup per remaining branch. Older run records require an exact merged PR head match.
  Preserve run data, attempt refs, shared caches, dirty work, unlanded commits and symlink targets; reject symbolic refs and recheck checkout identity before guarded removal.
- 8fbd9c8: Landed-run cleanup over a fetched mirror only considers branches with a checkout, so branches the next fetch restores are no longer removed and logged on every pass.
- ad43c87: Let custom harness readers access traces and news, and honor provider and harness defaults in config.
- 8e77784: `agi` parses its flags per verb: a flag the verb does not take is an error (exit 2), and `agi <verb> --help` shows that verb's flags. A verb's own flags go after the verb, so `agi --workflow w start text` is now an error; flags every verb takes, such as `--data` and `--tracker`, still go on either side. A flag given twice keeps its last value, except `--label` and `--run-label`, which add up. `-v` prints the version, like `--version`.
- fe1e95d: The agi verb and flag table lives in one module that tests read directly.
- 2781b8c: Read-only codex agents can read files again inside the docker sandbox. Codex no longer runs its own sandbox, which needs namespaces the container forbids; a session whose tools change nothing now gets its work tree, git dirs and dependency volumes mounted read-only instead, for every harness. A box server can't enforce that and refuses read-only sessions.
- 8a205f5: Comment commands now use colons: `/agent:stop`, `/agent:cancel`, `/agent:restart[:step]` and `/agent:<workflow>`. `/agent <text>` is always text. `commands` in `settings.yaml` turns commands off or keeps them to some logins.
- f0bc68a: A trusted `/agent` on a closed issue, a merged or closed pull request, or an open pull request no run works on now starts the comment workflow, and a comment said just before a merge is no longer lost when the merge ends the run. A run on a pull request that is no longer open starts from its base branch.
- c3131d3: `loop` compresses the trace and check record of runs ended and untouched for `AGENTGRAPH_COMPRESS_DAYS` days (14) with zstd; every reader opens them as before.
- 4ffa29f: An `on: conflict` workflow resolves a waiting run's conflict with its moved base in a run of its own, with a budget of its own, while the first run keeps waiting. `examples/conflicts` shows one.
- 19163fc: Traces record each sandbox container's peak memory, CPU time and whether it ran out of memory, as `used` on session, setup and script check lines, and studio shows them.
- 3ed7159: Share one process-wide limit between sessions and script checks to prevent container bursts across runs.
- 09bdec2: `agi dispatch` starts any workflow, the router included, and takes an optional text the run is asked first. `on: dispatch` now only decides what an agent's `run` proposal may start.
- f4f8499: Remove the Results Exports tab and the manual result sheet export CLI. Runs, Tunes and Bench keep their existing result views.

  Drop unused benchmark measurements and export-only axis hints.

- b9704ce: Persist uploaded images by hash before acknowledging them, and record their hash and session in the trace. Keep image bytes after sessions close while preserving session handle limits.
- d8ca9ae: Runs on Effect 4. A bad environment variable, `settings.yaml` or frontmatter is reported in Effect 4's wording.
- 52661b0: Reject missing scoring evidence and display empty checks as counted skips.
- 0ae5378: The commit hook runs `npm run check:fast`: the static checks and only the tests related to the change. `npm run check` runs the tests alongside the other checks and stays the gate before a merge.
- cca21bb: Plot bench scores against numeric run fields. Add an optional script to record graph size as run labels.
- 99b9ae5: Builds the production layers in one step.
- a919331: Restore the bench floor workflow's supported issue-comment trigger so the arm can run.
- 73ed527: The tracker that keeps issues in a local folder is called the folder tracker.
- 9a0913b: A forge loop now runs on the provider that AGENTGRAPH_PROVIDER names.
- a201204: Add read-only issue search scoped to the configured repository, with keyword and result limits.
- d390cbb: Rename forge to tracker: `--tracker` replaces `--forge`, `AGENTGRAPH_TRACKER` replaces `AGENTGRAPH_FORGE`, the plugin context field `forge` is `tracker`, and a local instance keeps its issues in `tracker/` instead of `forge/`.
- 7786926: A successful file handle read now consumes the handle and frees its slot and held bytes, so sessions can upload more than 32 images over time while keeping the limits on unread files and cumulative input.
- ed8356d: Create the bench cache before starting jobs in a fresh directory.
- 9dead2b: Route direct model authentication through the selected provider and clear stale session settings.
- 5140797: A long-running `agi loop` renews the provider login before each pass, so a ChatGPT login no longer expires mid-run. A failed renewal is logged and the pass keeps the last login.
- 7bcec96: Prefer live work runs over retros when delivering tells. A tell to a human wait step with back resumes work directly.
- 4e616a6: Show unfinished and untested status pills from hidden Markdown markers in the studio. Mark the hosting guide as untested.
- 1275648: Use dotted tooltip labels, compact filter rows and subtle dropdown fades in the bench sidebar.
- c99b287: The GitHub tracker fails a status change the repo refuses, also when only removing the old label fails.
- 4d9425e: Fail incomplete bench jobs and queues, and count missing or malformed trace records.
- bae9827: The graph issue shape no longer asks an agent to prescribe the check that would catch a miss.
- 660232d: Each run keeps the graph folder it started under as a git tree at `refs/agentgraph/graphs/<tree>` and records it once as `graphTree`.
- d2fb350: Show "loading runs" beside the Graph page's run picker until runs arrive, and the error when they fail to load or refresh, instead of looking like a graph with no runs.
- 7182203: Add authenticated MCP configuration for engine tools to all four harness adapters.
- a74e232: The host test sandbox no longer fails when parallel runs on one graph push the same graph ref at once.
- 531f3d5: Give tool plugins the session's host checkout path for read-only access to its files.
- b60cabd: Serve each session's selected host tools over authenticated MCP, with bounded execution and sanitized run traces.
- 6bc9ce0: The studio row test for an imported run passes the run labels every served run now carries.
- 32e4ac5: `instance.yaml` takes `tracker: <plugin>` to run a local instance on a tracker plugin from the built-ins or the instance's graph, which keeps its files in the instance's `tracker/`. `AGENTGRAPH_TRACKER_DIR` gives a tracker picked by name its folder.
- 9b08132: An interrupted host git, such as a box sync cut off by a command timeout, now removes its index lock, so the next sync does not fail on a stale lock. A git helper that ignores the stop is killed after five seconds.
- 4e11c0c: Add an issue-search plugin example and document host tools, session access and limits.
- c54c7a1: Appending to a run's labels, trace or check log holds a lock in the runs folder's `.locks`, so two processes recovering a cut last line no longer erase each other's edit.
- b4514b4: A judge reads at most 200,000 characters of a change, its start and end.
- 47cc99c: `agi label` also labels imported runs, which have no issue.
- 7b0a977: `agi check --runs` scores a run's output without the forge: it reads the run's issue text, kept change and last reply, and never posts status. A check that does not apply to a run gets an empty result marked `na` instead of failing, and a check's version now includes its judge's harness and model.
- dabd86a: Removing a checkout no longer blocks the runner while its files are deleted, and command output is scanned for the resource-usage line only where it can be.
- ea4c9b6: Run traces and check records are read without blocking the process, and the idle-run compression pass skips runs whose files are already compressed or still recent without reading their run.json.
- dff915d: Judge files after check scripts run, so generated changes invalidate cached judgments.
- 6ea2bb2: A loop pass looks at issues with live runs first, so a runner-error retry or a reply no longer waits behind every open issue. Reading what happened asks GitHub once per person, not once per label event.
- d62543f: A local instance reads an `.agentgraph/` that git does not track straight from disk, so a private graph can live in `.git/info/exclude`. `AGENTGRAPH_DIR` now picks the graph inside a repo too.
- ca5c289: `agi loop` drives runs in the background, so a long run no longer delays answers and new runs on other issues.
- 85574ae: Release the loop's data directory lock before exiting on SIGTERM or SIGINT so restarts can acquire it immediately.
- 73cff5e: Stop queues on read or receipt errors and reject invalid queue owner records.
- 26337ca: Keep valid metadata stable across JSON round trips and enforce export limits on the written bytes.
- 4bdcf6f: Reject empty owner records and report unexpected lock failures instead of silently treating work as unowned.
- a844d61: When an instance's tracker folder is missing, the CLI and the studio now say which folder is missing and exit, instead of the studio dying with `spawn git ENOENT`.
- 72d1bb2: A trace check run beside a file check no longer fails when the run's saved files are gone, and a file check that does not apply no longer opens a checkout.
- 9a39194: Results and the studio's run rows show a check result marked `na` as n/a instead of skipped.
- 1b3aeb1: Keep tooltip text in normal case and align the bench color control with its grouping row.
- 9d5fe62: `npm run check:examples` fails when a shipped example lets an agent return `merge`, so only a human merges.
- 1596219: The tracker is selected once (`--tracker`, else `AGENTGRAPH_TRACKER`, else `github` with the App env) for routing and `show`, and `agi check` says when the selection names nothing, names a plugin without a tracker, or needs a graph read from the repo.
- a9fe9ae: Add `agi resume <run id>` and `agi resume --parked` to retry runs parked by runner errors without a GitHub comment. Retros remain quiet.
- 1ffdeaa: Pin repo images consistently across loops, bench scoring and both arms. Limit automatic environment cleanup to recorded ownership while preserving shared volumes and live holds.
- 2ff04d2: Show one plain line with the remaining wait when another loop holds the data directory.
- c5872c3: Let steps opt into carrying successful replies to the next step under a heading naming their source. Keep image staging on the sandbox CLI.
- a538cc5: Require an explicit graph before running work. Copy the packaged starter example into `.agentgraph/`; the engine no longer falls back to a default graph.
- cfd67fb: Add graph plugin definitions with typed Effect Schema tools and separate settings namespaces. Validate plugin files, collisions and settings during graph checks.
- 38716a7: Resolve plugin imports of Effect, the AI SDK and the plugin API from the engine installation.
- cf08005: Allow plugins to declare studio pages and read-only data readers.
  Keep studio paths in server-only settings and share file invalidation across pages.
- 8e53fe9: Workflows can start when an issue's card moves into a project board column: `on: { issues: { column: Agent Ready } }`. With a `label` too, a column start also adds the label.
- 2606d54: Harnesses read the prompt on stdin from a file in the session home, so a long prompt no longer overflows the argument limit with `spawn E2BIG`. A defect while a run works, such as a failed spawn, now parks that run with a runner error instead of stopping the loop.
- 9a2b318: Let providers supply setup and login recovery guidance for the CLI.
- e31ab7d: Fail a push only when a held path is first reported on its branch. Keep listing held paths on later successful pushes so runs can continue.
- 8564c6e: Poll trusted tracker events between full passes so maintainer comments and labels reach the loop during a long sweep. Serialize ticks on the same issue and reuse existing event deduplication.
- 386ce86: Harness plugins classify their tools so custom tools get the right sandbox access.
- 0be5bf9: The default reviewer returns only `back`: its findings stay in the run instead of posting a pull request comment.
- 801850c: Create nested mountpoint folders before starting Docker commands so read-only sessions can use dependency volumes without setup.
- 4e2fe98: Checkouts, graph copies and sync state now live under `cache/` in the runs folder, so an instance folder without it is a full backup. Move old folders by hand as docs/runs.md shows.
- a0bf34d: Report held .github files in push results and traces. Treat incomplete pushes as failures so the proposing agent sees what did not land before posting replies.
- db76280: The docs coverage check reads Effect 4 schemas again, so renamed keys like usd-per-run and literal values stay covered.
- 2a92817: The example's size, lint and test-guards checks read a moved or copied file against its old path and count a rename's compound and case forms, even rewrapped, as the rename.
- 82f3ae1: Add a digest-pinned Node 22 derived sandbox recipe and verify all harnesses and the file client during offline smoke checks. Deployment startup now fails missing custom tags instead of filling them with stock contents.
- d536eac: Check finite bounds in the shared schema and keep result links local.
- 0fae4b8: Results count an imported run like any scored run instead of as dead, and an n/a check result is neither a warning nor a failed gate; a run's result lines list it as n/a.
- 368caca: A retried session sees the proposal shapes again, and why its proposals failed to parse.
- 69c82b3: `run` steps get the issue number and the run's traces, so a step can gate on how the run went. `examples/retro-gate` starts a retro after more than five failed tool calls.
- b1b29f0: A status the tracker refuses is shown again on the next pass; the sticky keeps the old status until the tracker takes the new one.
- 942481d: In a forge folder, a `pull_request` for a branch with an open pull request rewrites its title and body, as on GitHub, so a later step can keep the description current.
- d5d687b: A run a comment started now opens its prompt with that comment, its file and line, and the earlier comments of its review thread. A run with no branch reads the pull request it was asked on, and the timeline leaves out the runner's own labels and status comments.
- 1f92fae: Record caller metadata before runs start and when queued inputs are accepted.
- 811d944: A run's labels log survives a last line a crash cut short: reads skip and count it, and the next edit moves it to a `.partial` file before it appends.
- cfb7add: Runs take labels: free `key=value` metadata set with `agi start --run-label k=v`, `start({ labels })` or `agi label <run id> k=v k-` at any time, kept as an append-only log in `<run id>/labels.jsonl`.
- b8c9a21: Keep public run metadata by owner and show provenance and JSON in Results.
- fc66d5a: The load test expects a run step that reads traces to carry its default returns.
- 73279df: A `run` step gets `AGENTGRAPH_TRACES` and `AGENTGRAPH_RUN_TRACE` only with `reads: traces`, so a step that does not read them no longer reads every run on its issue on each try. The retro-gate example opts in.
- 268b51a: Test that a run step without `reads: traces` gets no trace files and prepares none.
- 13ba5ed: A run parked by a runner error now tries its step again on its own: after 10 minutes, doubling with each try, at most 5 times. A reply still tries it at once.
- f4e3544: A run can have no issue. The store's live reads (`get`, `list`) leave such runs out, so the loop, `show`, `resume`, `say` and traced context never see them; `getRecord` and `listRecords` return every run, and `check --runs` and results use them.
- 1a81dd6: Allow graph and step limits to set Docker memory and CPUs, keeping the defaults at 4g and 1.5 CPUs.
- 292cff7: A `run` step's printed proposals, `ask` and `back` included, are limited by its own `returns`, which defaults to `[run]`, so a repo command can no longer push, open a pull request, comment, ask or merge. A `merge` applies only from a step whose `returns` lists it, and `check:examples` reads CRLF graph files like the loader.

  An aside posts its answering agent's comment only when that agent's `returns` lists `comment`; every proposal is checked against the step's grants before an `ask` or `back` is handled.

- fa13aa8: Keep forge and plugin credentials out of the forwarded session environment. Redact known credentials and credential patterns before recording session output.
- c919798: A resumed session finds its home by name under the current data folder, so moving the data folder no longer stops runs with "is not a session home".
- 4a95363: Show Docker's own error when a session container cannot start.
- f75720f: Honor case test commands and report hidden-test skips and invalid cases.
- e4898f9: Write a checkout's tree in one place for commits and diffs.
- 1acba45: Fail on unreadable cache and log records instead of treating them as empty.
- 60a4f53: The shimmer on running graph nodes is half as strong.
- 628123c: A test lists an instance folder in sorted order again.
- 400fd65: A GitHub read that a narrowed App token is refused with a 404 is tried once more with a new token, so pull requests and file contents in a private repo stay readable. A merged pull request that can't be read, or one issue GitHub refuses, no longer stops the whole pass.
- e4d4c2c: A new run stays locked until its first status and eyes reaction are saved, so another pass cannot drive or stop it in between. A dispatched run whose id is taken gets a fresh one, and when none frees up the dispatch fails instead of reporting a run that was never saved. Storage errors while starting a run now surface instead of starting nothing.
- dfdeaff: Plugins can declare an `on.status` hook that runs after the engine changes an issue's status label; on GitHub the hook context has `tracker.writeField(issue, { project, field, value })`, which sets or, with `null`, clears a single-select field of the issue's card on a project board. A failing hook is logged and the run goes on.
- ddef4f2: Issues carry one status label: `agentgraph:working`, `agentgraph:needs-review`, `agentgraph:needs-answer`, `agentgraph:done` or `agentgraph:stopped`. It replaces `agentgraph:waiting`; remove that label from open issues by hand.
- 71e8635: Use the same collapsible ⁂ footer on engine comments and pull request bodies, linking to the studio when configured.

  Keep one sticky status comment per issue for all runs, with running costs and runner pauses. Questions and replies stay plain, and resuming clears the pause in place.

- fb05f99: A store or runner error whose cause cannot be turned into text still reports its path and an inspected cause instead of failing with "Cannot convert object to primitive value"; an Error cause now shows only its message.
- d25de87: Keep a run's full trace and check history when a long-lived store appends after the run was compressed again, and read a record that an append unpacks mid-read instead of reporting it empty.
- 1727e08: The Graph's run story names the step a run was sent back to, even when that step has left the graph, instead of the next step it still draws.
- 91d015e: The studio bench page loads fast and stays up: the studio no longer watches bench checkouts, reads finished arm usage from `usage.json`, rescans bench rows only when a log changes, answers a failing request with its error instead of hanging, and refetches at most once per change burst.
- 6406258: The studio build no longer pulls a node module in to tell runs on an issue from imported ones.
- aa7a7ca: The studio refuses to start when a graph plugin takes the name of a built-in page, `results` or `bench`, even without `--bench`, and names the plugin file in the error.
- 7d08175: Each studio port keeps its own Vite cache, so two studios no longer wipe each other's dependencies.
- cb8e1e0: Restart the studio server when engine code under `src` or `bin` changes, from both `agi studio` and the studio's `npm run dev`, so it never serves stale engine modules after an edit. A studio that fails to start still exits, with its status.
- 04edaf4: The studio shows a broken or empty server answer as a failure with Retry and keeps the data it had. It refetches once its live socket connects, reads the run list only while showing it, sends a single run without the list's trail and checks, and serves the graph modules without inline source maps.
- b356ab0: The studio Graph reads each way back's out-of-rounds mark from that outcome's own trace line, so a reason the run was given later, such as a rebase conflict, no longer marks the last way back as out of rounds. A check's Verdicts panel now shows a failed refresh over its earlier verdicts and offers a retry when the first load fails.

  A missing tracker folder is now reported as a tracker folder with no origin.git.

- d9ee58f: The studio's Runs list and run pages show imported runs, without an issue number; the inbox and graph keep to runs on an issue.
- 3836dbb: The studio run list carries only what the graph draws of each outcome, so long comments and findings stay on the run itself. A run opened from the list or the graph shows loading, a failed fetch with Retry, earlier data after a failed refresh, and a run that is gone.
- 885d1a6: The studio run list no longer carries check results or full run records: a check's verdicts are fetched when its panel opens, and each listed run keeps only the fields the list and the Graph read, with an issue's body sent once. On a 130-run data dir `/api/runs` drops from 788 KB to 191 KB.
- cc3a602: The studio follows edits to the served graph without a restart: Graph and the problems banner reload when a graph file changes. The first page load no longer pulls every example workflow just to show the banner.
- ac7bccc: Studio pages show loading, failure and stale data the same way: a failed first load offers Retry, a failed refresh keeps the earlier data under a short note, and the header shows when the server is unreachable. A page error can be retried without reloading the tab.
- c63b459: The studio Graph no longer crashes on a run that visited a step the current graph lacks. It draws the steps it knows and says which steps are not in the current graph.
- 9bbc574: The studio Graph marks a way back as out of rounds only when the run's round count did not move, so a run that stopped for another reason no longer shows every way back as out of rounds. A picked run's trace is fetched only for a step with checks.
- 1cb5157: `agi studio` exits with the studio's status when a restart after an engine edit fails to start, instead of hanging.
- d8f46db: The studio's Results page reads the graph as it stands after an edit, the same graph the Graph page reloads, instead of the one it found at start.
- 82e1e2a: The studio Runs page shows each run's labels, filters runs by one, and has a picker for which label keys show, kept in the browser.
- a4995f4: The studio run list loads a summary of each run instead of its whole trace, about a fifth of the bytes for a busy data dir. A run's steps load when its row is opened, and the graph loads the picked run's lines on demand.
- f36af74: The studio sends live updates over Vite's own socket and names what changed, so a bench write no longer refetches the run list and many open tabs no longer stall requests. A failing request shows the server's error.
- e7ea845: The studio uses Vite 8.3.3, which fixes the dev server advisories against 8.3.2, among them CVE-2026-112946.
- 85f3a4a: The studio no longer watches run checkouts, harness homes, caches or logs under its data, bench and tune folders, so it stays idle instead of burning CPU and reloading on every tsconfig change inside a run.
- b3e9e55: Tests drop git's repository environment variables, so running them from a git hook or rebase step cannot write into the surrounding repository.
- ed23dfa: Replace plugin checkout paths with session-scoped image handles and bounded binary uploads from local sandboxes.
- 33d694e: Give Docker checkouts private disk-backed /scratch space for temporary source trees, builds and screenshots.
- e99bd7f: Finish cancellation traces before closing a host tool session.
- 24879cb: Route sandbox tool calls to a restricted host listener through a temporary single-port relay.
- 11ffac6: Toolchain and package caches are kept per repo: each repo gets its own `agentgraph-cache-<repo>-<hash>` volume, hashed from the repo name (or its origin when it has none), the image ID and the toolchain, and `AGENTGRAPH_CACHE_VOLUME` is now the name prefix. Environment builds of one cache volume run one at a time. Environments are rebuilt once (format 7), and commands outside a checkout no longer mount a cache. `bin/env.ts` and low-disk collection count and remove cache volumes like environments, and free docker disk is measured without a volume. The old shared volume is no longer used; `docker volume rm agentgraph-cache` frees it.
- cf3e1f9: Record sandbox start errors in run traces when answering a waiting run or following a stacked branch.
- 6d6ce63: `agi say`, `review`, `close` and `merge` write the tracker folder under the same lock as a running loop, so neither loses the other's change.
- 31c3419: The built-in trackers ship as `folder` and `github` in `@jannik-stacks/agi/trackers`, so a graph plugin can wrap one under its own name.
- 1591739: An instance refuses a folder path as its `tracker`, and the loop checks the tracker plugin again whenever the graph changes. A callback that resumes after its tracker lock was released waits for the lock again.
- d6293fb: A tracker folder keeps each issue in its own folder, `<n>/issue.md` with `events.jsonl`, and the issue's status is the folder it sits in: `working/14/`, `needs-review/15/`. Folder trackers no longer add status labels. A tracker still in the old flat layout is refused. Stop the loop and move it: `<n>.md` to `<n>/issue.md`, `<n>.jsonl` to `<n>/events.jsonl`, `<n>.reactions` to `<n>/reactions`, keeping `<n>/pull.json` and `diff.patch`, then move an issue with a status label into the folder of that status and drop the label.
- 2a2da35: A tracker folder's reads take its lock too, a new issue appears only once complete, and `agi merge` holds the lock from checking the head to closing the issue. An instance refuses a tracker plugin that keeps its issues outside the instance's `tracker/` folder.
- d3e580f: Release the loop lock on SIGTERM or SIGINT when the loop runs on a tracker (`--tracker github` or a tracker folder), too.
- 191e366: Trackers are plugins: `--tracker` picks the built-in `github` or `folder` plugin, a graph plugin with a `tracker` member by name, or a tracker folder by path.
- 4a3bfee: The tracker shows an issue's status through its own `status` method, and the `status` setting in settings.yaml renames the status labels or turns them off with `false`. The sticky comment keeps the current status in a hidden marker.
- 763e7db: A run's outcome trace lines now carry the reason the run was left with, and the studio Graph marks a way back as out of rounds only when its own line says the run then asked or stopped, so an earlier way back is no longer told as out of rounds.
- 66d3e9d: The sandbox image and the deploy engine image move to Debian trixie for git 2.47. The engine merges with `git merge-tree --merge-base`, which needs git 2.40 or later, so rebases failed in the deploy image and agentgraph's own tests failed in the sandbox. The sandbox image also gets jq. Rebuild `agentgraph-sandbox:local` to pick both up.
- a9b3870: A tune scores each candidate as labelled bench runs (`tune=<name>`, `cand=<id>`) in the tune dir's `runs/`, through `bin/bench.ts --graph`. `tune/propose.ts --runs` is now `--cand <id>`.
- ea5409c: Count Docker volumes that are not measured yet as empty instead of failing disk inventory.
- 6ed0419: A step whose agent may push now fails a try that changes files but proposes no push, instead of passing with the change left unpushed.
- a0eeb20: A container's peak memory and CPU time are recorded even when its stderr arrives after the usage line.
- c91ab05: A local instance checks out from its tracker folder directly, so the second copy of the repo in `mirror.git` is gone. Branches reach your repo as a pack and one `agentgraph/<n>` ref, without your hooks, gc or index lock; `--read-only` keeps a repo untouched. To migrate an instance, copy its kept files into the tracker folder with `git --git-dir=<instance>/tracker/origin.git fetch <instance>/data/mirror.git '+refs/agentgraph/runs/*:refs/agentgraph/runs/*'`, then move `mirror.git` aside.
- bf1f55f: Record waiting-run catch-up errors once and retry only when the base, branch or graph changes.
- 28e3b99: Start workflows without a base on the repository's default branch.

## 0.0.2

### Patch Changes

- f5ad38e: Add a `chatgpt` provider: codex sessions run on a ChatGPT subscription through agentgraph's own `codex login`, with no gateway.

## 0.0.1

### Patch Changes

- 3bf9d78: First release on npm. Install it with `npm install -g @jannik-stacks/agi` and run `agi`. The package ships
  the CLI built to plain JavaScript, so it runs on Node 24 with no TypeScript loader. The studio still runs
  from a clone.

## Before npm

Work from before the first npm release. The 0.1.0 and 0.2.0 milestones never went to npm, so npm
versions start again at 0.0.1.

### After 0.2.0

- Check results move out of the trace into a per-run check record, `checks.jsonl`. Each entry has its
  time, the check's version and what judging it cost; a judge's transcript is its log, so judging no
  longer adds sessions to the run's trace. `run.json` has no `usd`; a run's cost is its sessions' sum.
  `check --runs` skips checks that already have a result under their current version, and trace-only
  checks run in an empty folder. A failed judge still records what it cost.
- Costs are the public list price from LiteLLM's pinned price table for every model, subscriptions
  included. A model without a price is listed as unpriced, never $0.
- The studio's Compound tab is now the Results tab at `/results`: what checks gave across runs, bench
  arms or tune candidates, as a table or a chart. A run's page shows its gates and results in two lines.
  `returns` fields take an optional `unit`. The example graph folds `tool-budget` into `run-stats`.

- The word hub is retired. `--hub` is `--dir`, `AGENTGRAPH_HUB` is `AGENTGRAPH_DIR`, `hub.yaml` is
  `settings.yaml`, `show hub` is `show graph`, the `hub` issue relation and label are `graph`, and the
  packaged default moved from `hub/` to `default/`. Sandboxes mount the folder at `/graph`. Tunes keep
  candidates under `cands/<id>/graph` and `graph.git`, and record `graph` instead of `hub`.
- `AGENTGRAPH_REPO`, when set, is the repo a graph works on instead of its `repo`, so a public graph can keep a
  placeholder.
- A committed `.agentgraph/` with symlinks or submodules is refused. The studio's Inbox commands carry
  the instance's `--repo` and `--data`.
- `start` and `say` take `--label`, repeatable; `show graph` prints the graph in use and its files.
- `npx agentgraph <verb>` inside any repo needs no setup: the first command makes a local instance
  under `--data`, `AGENTGRAPH_DATA` or `~/.agentgraph`. `start`, `say`, `review`, `merge`, `export`,
  `close`, `show`, `loop`, `check`, `dispatch` and `prune-logs` take the issue number as the handle.
  `bin/forge.ts`, `--instance`, `--issue <n>` as a run selector, `--all`, `status`, `tell` from the CLI
  and an instance's `keys.env` are gone. `--forge` or App credentials run the CLI as a runner, where
  `--data` stays the runs folder and `loop --once` replaces `--all`.
- Without `.agentgraph/` in the repo the CLI uses the packaged default graph; with it, the graph at the
  committed base.
- A finished drive writes `agentgraph/<n>` into your repo only when that ref is absent or still where
  agentgraph left it; `export --as` and `--patch` write elsewhere. The forge's base fast-forwards to
  your branch before each drive.
- `start`, `say` and `review changes` drive the issue in the foreground; while a `loop` holds the
  instance's lock they post and return with a `show` command. Ctrl-C stops a drive, and the run resumes on the next.
- `AGENTGRAPH_TRUST`, when set, is trusted instead of the graph's `trust`; the CLI sets it to the
  instance owner.
- instance.yaml has `repo`, `base`, `owner` and `exported`; `logs` is gone, use `--logs`.
- The studio takes `--repo` instead of `--instance`.
- Providers in `agentgraph.config.ts` (`claude`, `anthropic`, `litellm`) set the model
  settings for the harnesses they serve; `--provider`, `--harness` and `--model` pick, and an agent's
  harness the provider does not serve fails before filing. A subscription logs in on first use; the
  Claude token goes to the macOS Keychain.
- The `codex` harness always talks to the gateway as a custom Responses provider with the agent's key;
  a ChatGPT subscription comes from LiteLLM's `chatgpt/` models, which own the login and its refresh.
  The `chatgpt` provider and its `agentgraph-codex` volume are gone. The sandbox
  image installs Claude Code 2.1.296 and Codex 0.162.1, and the egress allowlist has their API hosts.
  It grants all of `edit`, `write` and `bash` or runs read-only; the graph check rejects tool limits it
  cannot keep.
- An agent's `harness` is optional: the first of `AGENTGRAPH_PROVIDER`'s, else the config's first.
  `AGENTGRAPH_HARNESS` runs every agent on one harness. `AGENTGRAPH_MODELS`
  maps model aliases, `*` for agents without a `model`.
- The CLI checks docker before it files or drives, and creates the sandbox networks, the egress proxy
  and the sandbox image when missing or out of date. The package is publishable: `bin/agentgraph.js` runs the
  TypeScript sources from `node_modules`, and `files` ships the engine, the default graph and the
  image sources.

- A check with `returns: number` traces a `value`: the share of items passed, or the number a script prints
  last. Without one it is `empty`, never 0.
- A workflow's `checks` run once when the run ends, as `warn`, and a killed runner runs the rest from the
  run's `owed`. `check <name>... --runs` runs checks on runs that already ended.
- A trusted comment speaks to the bot only when it says `/agent`, both to start a run and on the
  issue or pull request of a live run, review comments included. The `/agentgraph` command,
  `on.issue_comment.command` and plain replies are gone; write `issue_comment: {}`, and with several
  comment workflows name one as the first word after `/agent`.
- `@agent` calls the bot the same as `/agent`.
- An approval or merge that comes with `/agent` asks takes only itself; the asks go to the comment
  workflow.
- Only the comment workflow hears `/agent`; other runs hear what it tells them. A router agent
  decides with `comment`, `issue`, `run` (now with an optional `step`) and the new `tell`, which
  passes feedback, an answer, `stop` or `cancel` to the live run on an issue.
- An environment with dependency volumes counts as complete again when setup made nothing else, so a
  checkout with changed files no longer reinstalls its dependencies into its own volume. Existing
  environments are built once more.
- A bench run that drops a case's environment image also drops its dependency volume, and a bench
  command removes the dependency volumes of runners that are gone when it starts.
- `check` no longer names a replacement for a removed graph key, a retired proposal kind or a `bots/`
  folder; each fails like any unknown key or folder.
- The runner data dir defaults to `~/.agentgraph`, tunes to `~/.agentgraph/tune` and the bench
  driver's repos to `~/.agentgraph/tune/repos`. The cache collector no longer lists `bothub-*`
  docker objects.
- `node bench/drive.ts` is the one bench runner; `bin/bench-run.ts`, `npm run bench` and its
  `compare.md` are gone. The `v1` arm, which never ran, is gone too.

### Milestone 0.2.0

The baseline for tuning. From here on a repo gets better through its hub, and the engine changes
rarely. [The hub contract](docs/contract.md) lists the hub fields and commands that stay stable.

#### Tuning

- `bin/tune.ts` climbs one hub per repo. Proposers write candidate hubs, each is scored on fit and
  validate cases against the current best, and a candidate is kept only when its gains hold on a
  rerun. Every candidate stays as a commit in the tune's hub repo.
- `tune init` records the engine as the release tag the checkout sits on, or as the commit, and
  every later run refuses an engine whose `src/` tree differs.
- The studio's Compound tab draws each tune's climb, its cost and the diff of each step.
- The `tune-graph` skill runs the same loop by hand, and `scripts/status.sh` sums a tune up on one
  screen.

#### Toolchains

- When a checkout is made, a toolchain step installs what the repo names (the pinned Rust
  toolchain with clippy and rustfmt, then `cargo fetch`) into the `agentgraph-cache` volume, then runs
  the hub's new `toolchain` script. Later runs and checks reuse it and build offline.
- `AGENTGRAPH_CACHE_VOLUME` names another volume, and an empty value turns the step off.
- A file lock in the cache volume stops two runners installing toolchains at once.

#### Starting and sweeping

- A workflow with `issues: { label: agent:ready }` starts when a maintainer adds the label, once
  per issue. Adding it again after a done run starts nothing, and `/agentgraph restart` runs it again.
- `loop` first looks at every open issue once, so it catches up on what happened while it was
  down, then looks again every `AGENTGRAPH_EVERY` minutes.
- GitHub calls that are safe to repeat are retried with backoff on network errors and 502 to 504.
- A warning at start when the data dir or its mirror is under a temp dir, which the OS may clear.

#### Comments and pushes

- Once a question is answered, the status comment moves below the answer, so a finished run no
  longer reads as asking.
- A reply with no thread target is posted once, at the top level or under the newest thread, not
  into every open thread.
- Changes under `.github/` are left out of a push instead of refusing it, and the pull request
  names the files a maintainer must push.

#### Check logs

- Every check's full output is kept gzipped by content hash, and a check row in the studio opens
  it on demand.
- `AGENTGRAPH_CHECK_LOGS`, `--logs` or `logs` in `instance.yaml` keeps `all`, `failed` or `off`.
  `node bin/run.ts prune-logs --data <dir>` counts the logs no trace names, and `--apply` deletes
  them.

#### Bench

- `node bin/bench-run.ts --at <sha>` runs a case set on one engine commit. Arms are keyed by the
  engine's `src/` tree, so validity, arm and judge results are reused when only docs or hubs
  changed.
- `--point` (or `BENCH_POINT`) picks a harness and model, `--repeat` runs it several times,
  `usage.json` records what each run used, and the studio's Bench tab plots cost against quality.
- `BENCH_HUB` runs a case on a given hub, which is how a tune scores its candidates.
- Each repo's setup is built once per base commit into an image, and checkouts start from it.
  Scoring, validity and gating run every command in that container, and fail when docker or the
  image is missing instead of running on the host.
- Bench and tune runs survive a crash, a sleep or a dead proxy. Rerunning the same command resumes
  at the first unfinished run, partial work moves to `.attic/`, and a run that failed for
  infrastructure is retried, never scored as zero. `bench.ts status` and `tune.ts status` show
  progress, and `bin/overnight.sh` runs a queue of commands that resumes the same way.
- `tune/skill.ts` benchmarks the `tune-graph` skill as its own tune on the loop's cases, without
  the held-out ones.
- A finished run keeps only its records: dependencies live once per base in a docker volume that each
  checkout overlays with its own writes, never in a checkout,
  score trees go after scoring, Envs past `AGENTGRAPH_ENV_CAP` are evicted, and runs wait below
  `AGENTGRAPH_MIN_FREE_GB` free.

### Milestone 0.1.0

The first versioned release.

#### Engine

- Workflows start jobs from GitHub events or local issue files. A job casts a bot, hands it a
  skill and may stop on `until` or `requires`.
- Bots run on the opencode, pi or Claude Code harness. Each attempt ends in proposals that agentgraph
  validates before anything reaches the repository.
- Attempts repeat until the gating checks pass or the attempts run out. Failing findings go back
  to the bot. A human merges.
- Work that is parked or deferred resumes on the next run. Stalls, provider faults and crashed
  harnesses restart the session, at most twice per attempt, with a prompt that says why.
- Per-bot runs-per-day budgets, stop reasons recorded on each run, and a stop button.
- `serve` logs which model keys it loaded and why and how it exited, and refuses to start when a
  model endpoint rejects a bot's key.
- Context for each run: preloaded notes, surfaced notes and a decider model.
- A mirror per repository and one worktree per run.

#### Hubs and checks

- A hub is config: `hub.yaml`, bots, skills, checks, workflows and notes. `agentgraph check`
  validates it and fails closed.
- Checks are scripts or narrow bot judges, in modes `log`, `warn` and `block`. A script slices the
  change into hunks, items or files, and a bot answers one question per piece.
- A change with more items than a check takes is refused before any bot check runs, and the bot
  hears which check refused it and by how much.
- A check that already fails on the base commit in files the change did not touch is marked red on
  base. It does not hold the change, and the failure is filed once per base commit. The base
  result is kept per base commit and hub version.
- A human answer settles only what the bot asked. Review still fails a change that reaches past
  the issue, even when an answer asked for it.
- A docs paragraph that names code the change touched is read against the new code, even when the
  change edits no docs.
- Example hubs: `agentgraph`, `acme-app`, `clarinet`, `hub`. `agentgraph sim` replays scripted
  scenarios against a hub.

#### Sandbox

- Every harness run, script job and script check runs in a throwaway container with a read-only
  root, dropped capabilities, resource limits and a private network.
- The container reaches the model proxy, an egress proxy that allows GitHub and the npm registry,
  and a relay to Ollama. No token goes in. Pushes happen on the host.
- When docker or the image is missing the run fails as `sandbox-failed`. Nothing runs on the host.
- Hubs set their own environment: dependencies, setup script and an open network when needed.
- A LiteLLM proxy with one virtual key per bot (`infra/local`), and `logs --spend` to compare
  recorded calls with the proxy's logs.

#### Observability

- Each run leaves `run.json`, `prompt.md`, `events.jsonl`, `summaries.jsonl`, `outcome.json`,
  `stderr.log` and `spans.jsonl`. Secrets are masked.
- Traces: `spans.jsonl` holds the run as OpenTelemetry-shaped spans, metadata only, with a `run`
  span and `model_request`, `tool_use`, `check`, `ask`, `human_wait` and `stall` spans.
- Time buckets: every span carries a kind (model, edit, read, build, test, wait, stall, other).
  Hubs add shell patterns for build and test in `hub.yaml`.
- Timeline: `bench/timeline.mjs DATA ISSUE` prints one issue's runs, checks, human waits, cost and
  wall time per bucket, with wall time minus build and test.
- Every run records the engine commit and a hash of the hub's files; each hub version is kept
  under `hubs/`. Runs link to their parent and to the previous run on the issue.

#### Data kept

- Runs, parked branches and mirrors are never deleted.
- Each attempt's commit is kept under `refs/agentgraph/attempts/<run id>/<n>` in the mirror.
- Every run's work is parked on `<branch>-parked-<run id>`. A worktree removed for any other
  reason first keeps unsaved work on `agentgraph/kept-<run id>`, locally only.
- A run's `home/` and its `tmp/` are kept after scrubbing secrets.
- The bench driver keeps each case's diff and data directory.

#### Studio

- Studio draws each workflow as steps, bots and checks, shows what a job would see, and edits hub
  files with a save and commit action that commits as `update` and never pushes.
- Dashboard: runs, live events, diffs, pull requests, questions that need a human, and a stop
  button.
- Docs tab with the reference generated from the source.

#### Bench

- `bench/mine.mjs` mines cases from merged pull requests, `bench/run.mjs` splits cases and runs
  hub settings over them, `bench/compare.mjs` compares diffs, and `bench/timeline.mjs` prints an
  issue's timeline.

#### Known limits

- Each issue gets its own cargo build directory under the hub's cache, and nothing prunes old
  ones, so the cache grows with the number of issues.
- A hub change reaches only events after it. A run in flight keeps the old hub, and nothing warns
  about the runs it affects.
- Review questions that apply to every hub live in the agentgraph hub only.
- Run records are written to local disk. The `Files` interface for other backends is not wired
  in.
