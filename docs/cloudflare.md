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

## Compatibility and packages

- Compatibility date: `2026-08-22`, selected and tested with the current application.
- Compatibility flag: `python_workers`, required for Python Workers.
- `nodejs_compat` is absent because the deployed Worker is Python and does not require Node APIs.
- Runtime dependencies are resolved by `uv` and locked in `uv.lock`/`pylock.toml`.
- FastAPI runs through Cloudflare's supported ASGI adapter; no Uvicorn process is deployed.
- Pydantic is pinned to 2.10.6 because that version has a compatible `pydantic-core` wheel in the current Pyodide package index.
- `workers-py` and `workers-runtime-sdk` are development/tooling dependencies, not generic server frameworks.

Before adding Python packages, check Cloudflare's current Python package support. Packages requiring unavailable native extensions, subprocesses, a writable persistent filesystem, or a conventional long-running CPython server are not safe assumptions.

## Multiplayer state and cost

`backend/wrangler.jsonc` declares `GAME_ROOMS` bound to the exported Python `GameRoom` class, with the `v1-game-rooms` migration creating SQLite-backed Durable Objects. Wrangler applies this new namespace during an authorized deployment. Local `pywrangler dev` provisions and persists the binding locally; no Cloudflare account mutation is needed to develop or test lobbies.

Each code has its own object, so unrelated matches do not share a global coordination bottleneck. Each room retains at most eight players, 20 selected quotes, and a bounded state payload. Round deadlines and cleanup use alarms instead of server-side timer loops. Two-hour room expiry and 15-minute member inactivity limit retained state; explicit departure of the final member also deletes the room. The existing `2026-08-22` compatibility date supports `deleteAll()` deleting stored data and alarms together, and has not been changed for multiplayer.

[Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) includes Durable Objects usage within the account's minimum $5 USD monthly plan. Lobbies do not require a separate Durable Objects subscription. [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) measures the time spent building and deploying the app; live requests, Durable Object compute and storage have their own included allowances and overage rates within the platform.

As checked on 2026-09-05, the [Durable Objects pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/) lists these monthly Paid allowances: one million requests, 400,000 GB-seconds of compute, 25 billion SQLite row reads, 50 million row writes and 5 GB-month of stored data. Usage above those allowances is metered; ordinary Worker requests and CPU time are also accounted for. Use the linked pricing pages and account usage metrics when estimating a bill.

Room updates now use hibernating WebSockets. Cloudflare keeps idle clients connected while allowing Python to sleep, and automatic ping/pong messages do not wake the room. Personalized updates follow real changes and deadline alarms, so healthy clients no longer request state every 1.5 seconds. Automatic reconnection retains an HTTP fallback for networks that block WebSockets. This reduces repeated traffic; it does not remove usage metering.

The upgrade uses the existing class, binding, SQLite migration and compatibility date. `acceptWebSocket()`, socket attachments and auto-response timestamps support recovery after hibernation; the existing date also enables automatic close replies. See [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and the [Durable Object state API](https://developers.cloudflare.com/durable-objects/api/state/).

The same-origin API validates browser origins and accepts HTTP player credentials in `Authorization: Bearer` headers. Browser WebSocket upgrades offer the credential through a `session.<token>` subprotocol and negotiate only `knowthechat.v1` in the response. Tokens are randomly generated and stored only as SHA-256 digests in room state. Neither browser tokens nor private answers should be added to URLs or logs. Local Vite proxying preserves the original host so its forwarded requests satisfy the same origin check.

## Caching

The Python HTTP adapter passes Cloudflare `cf` cache settings to outbound `fetch` calls:

- Zonian instance discovery and per-instance date lists: 300 seconds
- current-day historical archive: 300 seconds
- completed historical days: 86,400 seconds
- emote-provider responses: 3,600 seconds
- final dynamic API response: `Cache-Control: no-store`

Discovered archive origins are accepted only when they match the source-controlled trusted-host allowlist. At most six instances are consulted, their date lists are merged, and the existing limits of 12 selected dates, 12,000 historical messages and two concurrent archive downloads remain in force. Upstream bodies are streamed with explicit size bounds even if `Content-Length` is absent. Requests have timeouts and the incoming JSON body is limited to 16 KiB.

## Observability

Wrangler enables Workers Logs at full head sampling and traces at 5%. The service emits structured JSON stage events with durations and counts, including request receipt, historical/recent fetches, parsing/filtering, emote loading, chatter ranking, quote selection, completion and failure. It does not log chat bodies, full archives, or secrets.

Inspect local logs in the terminal running `uv run pywrangler dev`. After an authorized production deployment:

```bash
cd backend
uv run pywrangler tail
```

## Local development

```bash
npm install
cd backend
uv sync
uv run pywrangler dev
```

In a second terminal at the repository root:

```bash
npm run dev
```

Vite proxies `/api/*` to `http://127.0.0.1:8787`. No production binding or credential is needed because all application providers are public HTTP services.

`pywrangler dev` runs the Worker in Cloudflare's local development runtime. The
frontend and backend unit tests run without starting either development server.

To exercise the exact combined routing rather than the Vite proxy:

```bash
npm run build
cd backend
uv run pywrangler dev
```

Then open `http://127.0.0.1:8787`.

## Deployment and rollback

The Worker is connected to the `Haruzz/knowthechat` GitHub repository through
Cloudflare Workers Builds. Its production branch is `main`; non-production branch
builds are disabled because GitHub Actions already validates pull requests. The
Cloudflare build settings use the repository root and run:

```text
Build command:  npm run build
Deploy command: npm run deploy:worker
```

Every merge or direct push to `main` therefore creates a Cloudflare build and, if
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
Required bindings are the automatically provisioned `ASSETS` binding and the configured SQLite-backed `GAME_ROOMS` Durable Object namespace.

For normal code-only deployments, inspect versions and roll back if health checks fail:

```bash
cd backend
uv run pywrangler tail
uv run pywrangler versions list
uv run pywrangler rollback
```

After rollback, verify `/`, `/logo.png`, a `POST /api/public-archive`, a two-player lobby, and both custom hostnames. The prior Worker version includes its prior script/assets deployment, so no DNS reversal should be necessary.

Cloudflare does not allow rollback across a Durable Object class lifecycle migration. The first deployment introducing `v1-game-rooms` therefore needs a forward-fix plan: retain the class export, binding, and migration history when reverting unrelated application code. Do not delete the namespace or add a class deletion migration to undo a frontend issue, because deleting a class deletes all of its rooms and stored data. Deployment, rollback, and account changes require explicit user authorization.

## Known toolchain limitations

- `pywrangler types` currently has a Windows path-resolution defect in its `@pyodide/ts-to-python` helper. Pyright uses runtime SDK types successfully, and `pywrangler deploy --dry-run` validates bundling.
- The Python bundle is larger than the old TypeScript Worker because it includes Pyodide packages.
- Random date/quote sampling means successful live responses are behaviorally equivalent, not byte-identical.

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
