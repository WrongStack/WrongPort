# WrongPort

English | [Türkçe](README.tr.md)

A small tool that shows which processes are listening on which TCP ports in your development environment: **CLI + web UI**. It focuses on known dev processes (node, vite, next, python, cargo, go, postgres, redis…), lists their ports, and terminates them safely.

## Install

```bash
npm install
npm run build        # dist/ (core + cli + api) and web-dist/ (web UI)
npm link             # optional: global `wrongport` command
```

## Usage

| Command | What it does |
| --- | --- |
| `wrongport` / `wrongport ls` | Lists listening ports and their owners as a table |
| `wrongport ls --all` | Bypass the dev filter, show every listening process |
| `wrongport ls --watch` | Live table, refreshes every 3s (`--watch 1` = 1s) |
| `wrongport ls --json` | Raw JSON snapshot |
| `wrongport kill 3000` | SIGTERMs the process listening on port 3000 (asks for confirmation) |
| `wrongport kill 1234 -f -y` | Sends SIGKILL to PID 1234 without asking |
| `wrongport serve` | Starts the web UI + API → http://127.0.0.1:3789 |
| `wrongport serve --open` | Same + opens the browser |
| `wrongport serve -p 0` | Picks a free port; the printed URL shows the real one |

## Security model

- Kill only works on PIDs **seen in a current scan**; via the API that scan is valid for 30 seconds. This endpoint is not a general-purpose "remote kill" service.
- The server binds to `127.0.0.1` only by default. Use `--host` to expose it to other machines on the network — be careful, this is an interface that grants kill authority.
- While loopback-bound, `/api/kill` only works with `Content-Type: application/json` (cross-site form requests get 415) and returns 403 when the `Host` header is not a loopback address — a page arriving via DNS rebinding can neither read scans nor authorize kills.
- WrongPort refuses to kill itself, pid 1, and invalid PIDs.
- The default signal is SIGTERM; `-9/--force` is a real SIGKILL.
- Scan failures (missing lsof, timeouts) return 503 + a descriptive `{error}` JSON from the API; unexpected errors return 500 + `{error}`.

## Configuration

`wrongport.config.json` (or `.wrongportrc.json`) in the project root, otherwise `~/.config/wrongport/config.json`:

```json
{
  "include": ["\\bnode\\b", "\\bvite\\b"],
  "exclude": ["\\bwebpack\\b"],
  "ports": [3000, 5173]
}
```

- `include`: case-insensitive regex over `"<name> <command>"`; **replaces the default list**.
- `exclude`: removes matching processes from the filtered result (WrongPort itself is always excluded).
- `ports`: restricts the result to these ports. Values outside 1–65535 are rejected with `ConfigError`; the CLI `--ports` flag applies the same validation (a broken `--ports` list cannot silently disable the filter).
- On the CLI, `--only` adds extra patterns, `--ports` adds an extra port constraint, `--all` bypasses the filter entirely.

## Development

```bash
npm run dev:api      # runs the API with tsx watch (3789)
npm run dev:web      # Vite dev server (5174, /api → 3789 proxy)
npm run typecheck    # tsc for both the node and web sides
npm test             # vitest: 17 files / 194 unit tests (details: Tests below)
npm run test:coverage  # same suite + v8 coverage report (100% gate)
npm run verify       # typecheck + coverage-gated tests + build (one command, in order)
npm run release      # release pipeline — see Release below
npm run build        # tsc + vite build
```

## Release

```bash
npm run release            # verify → version bump (patch) → commit + tag v*
npm run release -- minor   # major | minor | patch
npm run release -- --push  # also push the branch and tag
npm run release:dry        # plan only: no writes, no commit, no tag
```

The script refuses a dirty working tree; outside `--dry-run` it also refuses any branch but `main`. It then runs `npm run verify` — typecheck, tests and the 100% coverage gate included — then bumps `package.json`, `package-lock.json` and the CLI banner in `src/cli/index.ts` in lockstep, commits `chore(release): vX.Y.Z` and tags `vX.Y.Z`. Nothing leaves the machine without `--push`.

## Tests

```bash
npm test               # vitest run — 17 files / 194 tests (~2.5s)
npm run test:coverage  # same suite + v8 coverage report
```

Coverage is enforced at **100% statements / branches / functions / lines** in `vitest.config.ts`; a drop below 100 fails the suite, so it can only ratchet up. Interface-only `types.ts` files and CSS carry no runtime statements and are excluded from the report.

| File | Coverage |
| --- | --- |
| `src/core/inspector.test.ts` | lsof output parsing: rows with/without the ` (LISTEN)` suffix, IPv4/IPv6 binds, skipping header/broken/portless/out-of-range rows, empty output; `joinListenRows`: ps preference, scan-race fallback, port merging/dedup; `scanProcesses` selection semantics against a **stubbed `execFile`** (no real lsof/ps): default dev filter, additive `only=`, hard `ports=` constraint incl. `all=1`, config-ports fallback, exclude patterns, `matched` flags, sort + pid tiebreak, and every `ScanError` mapping (missing lsof/ps, exit 1 = empty result, generic and non-Error failures) |
| `src/core/config.test.ts` | Config discovery and validation: file precedence (`wrongport.config.json` > `.wrongportrc.json` > `~/.config`), broken JSON and type errors → `ConfigError`, non-object config roots rejected, default include/exclude merge (WrongPort itself is always excluded), invalid regex rejection |
| `src/core/kill.test.ts` | Kill safety: invalid pid rejection (0, 1, negative, NaN), self-pid guard, missing pid → `ProcessNotFoundError`, real child-process SIGTERM and SIGKILL flows, EPERM/ESRCH probe mapping, wrapped signal failures, wait-timeout → `exited: false` |
| `src/server/app.test.ts` | API safety rails via hono `app.request` with an **injectable scan double** — kill paths stay real (spawned processes + real signals): malformed body → 400, unseen pid → 409, snapshot kill → 200 + real exit + repeat → 409, self-pid → 500, vanished-pid → 404; query params forwarded (`ports=` hard constraint incl. `all=1`, additive `only=`, empty/broken tokens, `ports=` empty → port 0 quirk); invalid `only=` → 400 + message; hardening: missing/non-JSON content type → 415, foreign `Host` → 403; error mapping: `ScanError` → 503, unexpected → 500; static UI serving: SPA fallback, trailing-slash directories, immutable `/assets/`, mime map, traversal → 403, NUL/bad-escape → 400, missing shell → 404; `startServer`: EADDRINUSE, port 0, `WRONGPORT_PORT`/`WRONGPORT_HOST` env precedence, `0.0.0.0`/`::` → localhost display |
| `src/server/app.server.test.ts` | `startServer` bind handling with a mocked `serve`: EACCES → privileges hint, generic bind errors, `address()` fallback, wildcard display, stray post-listen socket errors swallowed |
| `src/cli/index.test.ts` | the full CLI through commander with mocked I/O: bare command = `ls`, `--json`, `--only/--ports/--all` forwarding, `--ports` validation errors, watch mode (transient failures tolerated, 5-streak stop, exit-code recovery, 3s cadence incl. bare/non-numeric values), `kill` (pid/port/`-a` targeting, y/yes/decline confirmations, `ProcessNotFoundError` vs generic vs non-Error failures), `serve` (missing web build warning, port/host options, per-platform `--open` spawn + failure tolerance), main-module guard (incl. symlinked-bin realpath), CLI version ↔ package.json sync |
| `src/cli/table.test.ts` | table renderer: header/rows/footer, narrow-stdout sizing, name/command truncation, hidden-by-filter and empty-machine states, ANSI helpers |
| `web/src/filterQuery.test.ts` | UI filter box → server param mapping: number/number list → `ports`, any other text → `only` (regex), empty input → no params |
| `web/src/api.test.ts` | Client API layer: query param building, surfacing server error messages, bare-status fallback when the body carries no `error`, 409 "stale snapshot" kill recovery (refresh + retry once; no retry for other errors) |
| `web/src/portAddress.test.ts` | Wildcard bind (`*`, `0.0.0.0`, `[::]`, `::`) vs loopback/LAN address distinction incl. colon-less addresses — port badge coloring builds on it |
| `web/src/useProcesses.test.tsx` | data hook: 250 ms debounce, interval polling on visible tabs, hidden-tab tick skipping + ignored visibilitychange, refresh on becoming visible, filter-change refetch, error surfacing vs `AbortError` swallowing, refresh aborts the in-flight request, unmount abort |
| `web/src/App.test.tsx` | App shell: counts/platform, table + mobile card layouts, unfiltered badge, empty states (loading / idle / filtered / hidden hint), filter debounce → `only=`/`ports=`, all-toggle, cadence select, refresh button state, suggestion chips, server + action error banners with dismiss, two-step kill (`kill` and `-9`) in both layouts with post-kill refresh |
| `web/src/main.test.tsx` | bootstrap mounts the app into `#root`; throws when `#root` is missing |
| `web/src/components/PortBadges.test.tsx` | Badge tones (jsdom + Testing Library): wildcard → `*:port` + warning tone, loopback → normal tone, specific interface → warning tone with a non-"loopback only" title |
| `web/src/components/PidCell.test.tsx` | PID cell: click copies to clipboard and shows "copied ✓"; the flash clears after 1.2 s; degrades silently when the clipboard is unavailable or rejects |
| `web/src/components/HiddenProcessesHint.test.tsx` | Hidden-process hint: renders nothing for 0/negative counts, renders the count and guidance for positive ones |
| `web/src/components/KillButton.test.tsx` | Two-step safety button: first click arms (confirm label + danger tone), second click fires `onConfirm` exactly once; blur and the 2.5s timeout disarm, confirming just before the deadline still works |

Notes:

- Kill and API tests use **only throwaway child processes spawned by the test itself**; thanks to the snapshot-membership constraint they cannot touch other processes on the machine.
- Scans are faked at the `execFile`/`scanProcesses` boundary, so the suite is platform-independent (macOS, Linux, Windows). `lsof` is only required to **run** WrongPort itself, not its tests.
- The `useProcesses` identity guard protects the `refreshing` flag only — a late response still overwrites the snapshot (pinned by a test).
- `GET /api/processes?ports=` with an empty value parses as port `0`, which nothing can own — pinned as a documented quirk.
- The UI filter box is wired server-side (250 ms debounce): numbers → `ports=`, any other text → `only=`. The old client-side substring filter was removed — the difference: client-side could only narrow the rows the server had already returned; the server-side filter (`only`) can reveal processes hidden by the default dev filter, while `ports=` is a hard constraint in every mode including `all=1`. An invalid `only` pattern (e.g. `[`) returns 400 + an explanatory message, shown in the UI error banner.
- `ls --watch` keeps looping through one-off scan failures (timeout, busy machine); 5 consecutive failures stop watch mode, and the exit code is cleared after a recovery.
- UI component tests run with jsdom + Testing Library via a per-file `// @vitest-environment jsdom` directive — the global environment stays 'node' so server tests don't slow down. `@testing-library/react` and `jsdom` are devDependencies.
- In the UI, wildcard-bound ports (`*:3000`, `0.0.0.0`, `[::]`) render as `*:port` in the warning color — the answer to "is my dev server exposed to the network?" at a glance. Ports bound to a specific interface (e.g. `192.168.1.5:3000`, `[::ffff:…]`) also render in the warning color with a "may be reachable from the network" note; only loopback badges use the normal color. Clicking a PID cell copies it to the clipboard.
- When the table has rows, the count of extra processes hidden by the dev filter is printed below it (revealed by ticking "all processes").
- A UI kill retries once — refreshing the snapshot first — on the server's 409 (stale snapshot) response, regardless of message wording; killing still works when polling is off or the confirmation was slow. Returning to the tab triggers an immediate refresh instead of waiting for the next poll.

## HTTP API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/processes?all=1` | Snapshot (JSON); `only`, `ports` query params optional; invalid `only` pattern → 400 + message; scan failure → 503 + `{error}`, unexpected error → 500 + `{error}` |
| `POST /api/kill` | Body: `{"pid": 1234, "force": false}`; `Content-Type: application/json` required (otherwise 415); when loopback-bound the `Host` header is validated (foreign → 403); pid ≤ 1 → 400; pid missing from the last scan window → 409 |

Requirements: Node ≥ 22, macOS or Linux (`lsof`).
