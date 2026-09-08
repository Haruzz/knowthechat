# Cloudflare operations

## Deployment shape and routing

The application is one Cloudflare Worker deployment, not two publicly routed Workers:

- Wrangler uploads `frontend/dist` through Workers Static Assets.
- `assets.not_found_handling` supplies `index.html` for SPA navigation.
- `assets.run_worker_first: ["/api/*"]` invokes Python only for API paths.
- Python returns 404 for unknown `/api/*` paths instead of falling through to the SPA.
- `/api/rooms*` uses the same Python Worker and internal `GAME_ROOMS` Durable Object binding. HTTP commands use FastAPI; `/:code/events` upgrades forward natively to the object for WebSocket hibernation.
- The Worker name remains `know-the-chat`.
- `knowthechat.com` and `www.knowthechat.com` are declared as Custom Domains because the Worker is the origin.

This avoids a frontend proxy Worker and service-binding hop while retaining `fetch("/api/public-archive")`. Both Custom Domains are configured on the Worker; normal application deployments do not require DNS changes.

`backend/wrangler.jsonc` is the deploy source of truth. `frontend/wrangler.jsonc` exists only so the official Cloudflare Vite plugin reproduces SPA asset behavior during frontend development/build; do not deploy it as the production application.

## Edge rate limiting

Cloudflare edge rate-limiting rules are managed per zone, separately from the Worker deployment.

When hosting another instance, configure edge rules for that zone; deploying this repository does not install them. The [multiplayer admission coordinator](#multiplayer-admission-limits) is a separate application component that coordinates shared room and preparation capacity.

## Compatibility and packages

- Compatibility date: `2026-08-22`, selected and tested with the current application.
- Compatibility flag: `python_workers`, required for Python Workers.
- `nodejs_compat` is absent because the deployed Worker is Python and does not require Node APIs.
- Runtime dependencies are resolved by `uv` and locked in `uv.lock`/`pylock.toml`.
- FastAPI runs through Cloudflare's supported ASGI adapter; no Uvicorn process is deployed.
- Pydantic is pinned to 2.10.6 because that version has a compatible `pydantic-core` wheel in the current Pyodide package index.
- `workers-py` and `workers-runtime-sdk` are development/tooling dependencies, not generic server frameworks.

Before adding Python packages, check Cloudflare's current Python package support. Packages requiring unavailable native extensions, subprocesses, a writable persistent filesystem, or a conventional long-running CPython server are not safe assumptions.

## Multiplayer state

`backend/wrangler.jsonc` declares `GAME_ROOMS` bound to the exported Python `GameRoom` class, with the `v1-game-rooms` migration creating its SQLite-backed namespace. The additional `ROOM_ADMISSION` binding uses the exported `RoomAdmission` class and the additive `v2-room-admission` SQLite migration. Both classes stay inside the existing Worker. Local `pywrangler dev` provisions and persists these bindings locally; no Cloudflare account mutation is needed to develop or test lobbies.

Each code has its own object; guesses, room updates and heartbeats remain independent across matches. Only admission and room lifecycle operations contact the shared coordinator. Each room retains at most eight players, 20 selected quotes, and a bounded state payload. Round deadlines and cleanup use alarms instead of server-side timer loops. Two-hour room expiry and 15-minute member inactivity limit retained state; explicit departure of the final member also deletes the room. The existing `2026-08-22` compatibility date supports `deleteAll()` deleting stored data and alarms together, and has not been changed for multiplayer.

Room updates now use hibernating WebSockets. Cloudflare keeps idle clients connected while allowing Python to sleep, and automatic ping/pong messages do not wake the room. Personalized updates follow real changes and deadline alarms, so healthy clients no longer request state every 1.5 seconds. Automatic reconnection retains an HTTP fallback for networks that block WebSockets.

The eight-player limit includes the host and is enforced by the server; available seats go to successful joins while the room is waiting. The current implementation sends a personalized full roster to every connected client after a change, so increasing the player constant alone is not sufficient for audience-sized games. Larger rooms need smaller updates and burst/load measurements first.

The WebSocket transport uses the existing room class, binding and compatibility date. `acceptWebSocket()`, socket attachments and auto-response timestamps support recovery after hibernation; the existing date also enables automatic close replies. See [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and the [Durable Object state API](https://developers.cloudflare.com/durable-objects/api/state/).

The same-origin API validates browser origins and accepts HTTP player credentials in `Authorization: Bearer` headers. Browser WebSocket upgrades offer the credential through a `session.<token>` subprotocol and negotiate only `knowthechat.v1` in the response. Tokens are randomly generated and stored only as SHA-256 digests in room state. Neither browser tokens nor private answers should be added to URLs or logs. Local Vite proxying preserves the original host so its forwarded requests satisfy the same origin check.

## Multiplayer admission limits

Set these string variables in `backend/wrangler.jsonc` when hosting your own instance:

| Variable                    | Default | Scope                                                                                      |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `ROOM_MAX_OPEN`             | `"10"`  | Open rooms and preparations across the site, including waiting lobbies and final standings |
| `ROOM_PREPARATIONS_PER_DAY` | `"100"` | Admitted creation/rematch archive preparations across the site over the previous 24 hours  |
| `ROOM_MATCHES_PER_DAY`      | `"100"` | New-match admissions across the site over the previous 24 hours, including rematches       |
| `ROOM_CREATIONS_PER_MINUTE` | `"3"`   | Admitted new-room preparations from one hashed network key over the previous 60 seconds    |

Values must be decimal strings from 1 through 10,000; invalid settings fail closed. These are rolling windows, so allowances recover as old admissions expire rather than resetting at midnight. Every admitted archive preparation counts, including each rematch attempt and failed upstream fetch. A rematch reserves its next-match admission before fetching fresh chat; retries for that pending match reuse the same admission, and starting the successfully prepared rematch does not count it twice.

The shared ledger checks and reserves capacity before a new room fetches archives. New-room preparations have a 90-second timeout and a two-minute pending reservation. An activated reservation expires with its two-hour room or releases when the room closes. Rematches retain that existing slot and do not consume another per-network room-creation entry. Existing games keep running when an admission limit is reached. HTTP errors include a readable message and, where available, retry seconds in both `retryAfter` and `Retry-After`; the browser waits for a manual retry.

Admission records are cleaned up with requests and alarms. Network hashes remain only for the 60-second creation window; preparation and match records remain for their 24-hour windows. The application does not store raw IP addresses in the admission ledger. People sharing a public IP also share its creation limit. Requests without client-address information, such as local Wrangler requests, share one fixed creation bucket with the same limits.

Fresh rematches reuse the channel, original rolling range or calendar year, and chatter pool. Each fetch excludes the room's stored hashes of up to 2,000 recently used quote texts. The old results remain until a complete fresh deck is ready. Insufficient fresh quotes or a fetch failure returns an error without replacing the deck or clearing scores. The host can retry or create a lobby with different settings. Preparation is capped at 90 seconds; create and rematch clients allow 110 seconds to receive the server's response. The bounded history is internal and is deleted with the room.

When introducing the admission binding to an existing deployment, rooms without reservations can finish their current game, but hosts must create a fresh lobby before starting another game or rematch. Rooms without stored original archive settings also need a new lobby before rematching. Preserve both migration entries and class exports during later changes.

## Caching

The Python HTTP adapter passes Cloudflare `cf` cache settings to outbound `fetch` calls:

- Zonian instance discovery and per-instance date lists: 300 seconds
- current-day historical archive: 300 seconds
- completed historical days: 86,400 seconds
- emote-provider responses: 3,600 seconds
- final dynamic API response: `Cache-Control: no-store`

Discovered archive origins are accepted only when they match the source-controlled trusted-host allowlist. At most six instances are consulted and their date lists are merged. The provider selects active dates across chronological buckets using message-count metadata, then requests bounded `limit`/`offset` windows rather than whole archives. The initial pass selects at most 12 dates (four for rolling periods up to 30 days, six up to 90 days) and retains at most 6,000 messages. If the playable pool is too small, one expansion pass selects at most six dates and retains up to 4,000 additional messages; the service caps the combined sample at 10,000. Archive bodies are fetched one at a time, while activity-stat requests have concurrency six. Upstream bodies are streamed into a size-bounded buffer before JSON parsing, even without `Content-Length`. Requests have timeouts and incoming API JSON is limited to 16 KiB. These limits live in [archives.py](../backend/src/providers/archives.py) and [public_archive.py](../backend/src/services/public_archive.py).

## Observability

Wrangler enables Workers Logs at full head sampling and traces at 5%. [PublicArchiveService](../backend/src/services/public_archive.py) emits one structured JSON `request_summary` per archive request, with total duration, outcome, channel/period, sampling and filtering counts, emote/catalog counts, and available error details. It does not emit a separate log for each pipeline stage or log chat bodies, full archives, or secrets.

Inspect local logs in the terminal running `uv run pywrangler dev`. After an authorized production deployment:

```bash
cd backend
uv run pywrangler tail
```

## Local development

Use the [development guide](development.md) for prerequisites, installation, the Vite/Worker setup, and [production-style local routing](development.md#production-style-local-worker). Local Durable Object bindings are simulated without production account changes; archive providers are still public HTTP services.

### Local admission smoke test

The commands and isolated persistence setup have moved to [Development: local admission smoke test](development.md#local-admission-smoke-test). Use fresh local persistence for each run because rolling admission counters survive server restarts.

## Deployment and rollback

The recorded production setup connects the Worker to the `Haruzz/knowthechat`
GitHub repository through Cloudflare Workers Builds, with `main` as the production
branch and non-production branch builds disabled. These are account-side settings,
not configuration enforced by this repository; verify them in Cloudflare when
changing build integration. The recorded settings use the repository root and run:

```text
Build command:  npm run build
Deploy command: npm run deploy:worker
```

With those settings, every merge or direct push to `main` creates a Cloudflare build and, if
the build succeeds, deploys the combined Worker. GitHub Actions runs formatting,
linting, type checks, tests, and a deployment dry run on pull requests. It does
not deploy the application.

Cloudflare's build image includes Python 3.13 but does not document `uv` as a
preinstalled tool. Every repository command that needs `uv` therefore goes through
`scripts/with-uv.mjs`. It uses an existing local installation when available and,
only on a Linux build machine where `uv` is missing, installs pinned `uv` 0.12.5
into `$HOME/.local/bin` using Astral's official versioned installer. GitHub Actions
installs the same pinned version through `astral-sh/setup-uv` before running checks.

This preserves normal local execution. A missing local installation produces a
clear error instead of silently installing software.

Preflight without changing Cloudflare:

```bash
npm run check
```

Production deployments are performed by Workers Builds after a push to `main`.
Required bindings are the automatically provisioned `ASSETS` binding and the configured SQLite-backed `GAME_ROOMS` and `ROOM_ADMISSION` Durable Object namespaces.

For normal code-only deployments, inspect versions and roll back if health checks fail:

```bash
cd backend
uv run pywrangler tail
uv run pywrangler versions list
uv run pywrangler rollback
```

After rollback, verify `/`, `/logo.png`, a `POST /api/public-archive`, a two-player lobby, and both custom hostnames. The prior Worker version includes its prior script/assets deployment, so no DNS reversal should be necessary.

Cloudflare does not allow rollback across a Durable Object class lifecycle migration. Deployments introducing `v1-game-rooms` or `v2-room-admission` therefore need a forward-fix plan: retain both class exports, bindings and migration history when reverting unrelated application code. Do not delete a namespace or add a class deletion migration to undo a frontend issue, because deleting a class deletes its stored data. Deployment, rollback, and account changes require explicit user authorization.

## Known toolchain limitations

- The pinned `@pyodide/ts-to-python` helper has a Windows file-URL defect. Use `npm run types:worker`, which applies the scoped loader workaround and updates the checked-in `backend/typings/js/__init__.pyi`; running bare `pywrangler types` skips that wrapper. See [Python runtime types](development.md#python-runtime-types).
- The Python bundle is larger than the old TypeScript Worker because it includes Pyodide packages.
- Historical date/window selection is deterministic for the same metadata and inputs; private multiplayer deck/choice selection uses randomness. Changing public archive contents and random round selection mean live responses are not byte-identical.

## Official references

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Workers Static Assets and SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Python package support](https://developers.cloudflare.com/workers/languages/python/packages/)
- [FastAPI on Python Workers](https://developers.cloudflare.com/workers/languages/python/packages/fastapi/)
- [Workers Builds build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers Builds branch control](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)
- [Installing uv](https://docs.astral.sh/uv/getting-started/installation/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Python Durable Objects support](https://developers.cloudflare.com/changelog/post/2025-05-14-python-worker-durable-object/)
- [Durable Object rules and SQLite storage](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Atomic data and alarm cleanup](https://developers.cloudflare.com/changelog/post/2026-02-24-deleteall-deletes-alarms/)
- [Workers Builds pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Rollback binding constraints](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings)
