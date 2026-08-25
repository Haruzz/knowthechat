# Cloudflare operations

## Deployment shape and routing

The application is one Cloudflare Worker deployment, not two publicly routed Workers:

- Wrangler uploads `frontend/dist` through Workers Static Assets.
- `assets.not_found_handling` supplies `index.html` for SPA navigation.
- `assets.run_worker_first: ["/api/*"]` invokes Python only for API paths.
- Python returns 404 for unknown `/api/*` paths instead of falling through to the SPA.
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

Inspect local logs in the terminal running `uv run --directory backend pywrangler dev`. After an authorized production deployment:

```bash
uv run --directory backend pywrangler tail
```

## Local development

```bash
npm install
uv sync --directory backend
uv run --directory backend pywrangler dev
# second terminal
npm run dev:frontend
```

Vite proxies `/api/*` to `http://127.0.0.1:8787`. No production binding or credential is needed because all application providers are public HTTP services.

`pywrangler dev` runs the Worker in Cloudflare's local development runtime. The
frontend and backend unit tests run without starting either development server.

To exercise the exact combined routing rather than the Vite proxy:

```bash
npm run build
uv run --directory backend pywrangler dev
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
linting, type checks, tests, and a deployment dry run on pull requests and `main`.
It does not deploy the application.

Cloudflare's build image includes Python 3.13 but does not document `uv` as a
preinstalled tool. Every repository command that needs `uv` therefore goes through
`scripts/with-uv.sh`. It uses an existing local installation when available and,
only on a Linux build machine where `uv` is missing, installs pinned `uv` 0.12.5
into `$HOME/.local/bin` using Astral's official versioned installer. GitHub Actions
installs the same pinned version through `astral-sh/setup-uv` before running checks.

This preserves normal local execution through Git Bash. A missing Windows
installation produces a clear error instead of silently installing software.

Preflight without changing Cloudflare:

```bash
npm run check
```

Production deployments are performed by Workers Builds after a push to `main`.
The only required binding is the automatically provisioned `ASSETS` binding.

Rollback immediately if health checks fail:

```bash
cd backend
uv run pywrangler tail
uv run pywrangler versions list
uv run pywrangler rollback
```

After rollback, verify `/`, `/logo.png`, a `POST /api/public-archive`, and both custom hostnames. The prior Worker version includes its prior script/assets deployment, so no DNS reversal should be necessary.

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
