# Repository guidance for coding agents

## Project baseline

- Know The Chat is a Twitch chat guessing game.
- The frontend is a browser-rendered React + Vite + TypeScript application in `frontend/`.
- The backend is FastAPI running through Cloudflare's Python Workers ASGI adapter in `backend/`.
- Production is one Cloudflare Worker named `know-the-chat`: Workers Static Assets serves the frontend and Python handles `/api/*`.
- Preserve the same-origin `POST /api/public-archive` contract. Do not add CORS or a second public API hostname without a documented requirement.

## Sources of truth

- `backend/wrangler.jsonc` is the production deployment configuration.
- `frontend/wrangler.jsonc` supports frontend development and builds only; do not deploy it as the application.
- `frontend/src/App.tsx` owns browser state and gameplay.
- `backend/src/fastapi_app.py` owns public HTTP routing and validation.
- `backend/src/services/public_archive.py` orchestrates providers and domain logic.
- `docs/architecture.md` and `docs/cloudflare.md` describe the supported architecture and operations.

## Development environment

- Use Node.js 22.13 or newer, Python 3.13, npm and uv.
- Run commands from the repository root unless documentation says otherwise.
- Repository commands invoke `scripts/with-uv.mjs`; it uses the developer's installed uv and bootstraps pinned uv only on Linux CI/build machines.
- Do not edit generated `frontend/dist`, Python virtual environments, `python_modules`, caches or Wrangler output.

Start local development in two terminals:

```bash
npm run dev:backend
npm run dev:frontend
```

Vite proxies `/api/*` to `http://127.0.0.1:8787`.

## Implementation principles

### Frontend

- Keep TypeScript strict and avoid `any` unless an external boundary makes it unavoidable and documented.
- Preserve keyboard interaction, accessibility labels, responsive behavior and same-origin API requests.
- Keep network and browser-side state transitions explicit and test user-visible behavior with Vitest and Testing Library.
- Reuse the existing visual language and components before introducing new abstractions or dependencies.

### Backend

- Use FastAPI and Pydantic at untrusted HTTP boundaries; prefer dataclasses and plain types internally.
- Keep the Cloudflare entrypoint and FastAPI route thin. Put orchestration in services and deterministic rules in pure domain functions.
- Use small `Protocol` interfaces and constructor injection for replaceable providers. Do not add a dependency-injection framework.
- Bound request and upstream response sizes, apply timeouts and isolate optional provider failures.
- Design for the Workers memory limit: stream or process incrementally, cap retained messages and avoid materializing duplicate large payloads.
- Verify Cloudflare Python package compatibility before adding dependencies. Do not assume subprocesses, persistent writable storage, arbitrary native extensions or a conventional server process.

## Cloudflare rules

- Consult current official Cloudflare documentation before platform-specific changes and use the Cloudflare MCP when account context is relevant.
- Keep `assets.run_worker_first` limited to `/api/*` so static assets bypass Python.
- Explain and verify compatibility-date or compatibility-flag changes.
- Keep bindings and secrets in Wrangler/Cloudflare configuration, never in source control.
- Do not deploy, change DNS/custom domains or mutate Cloudflare account state without explicit user authorization.
- Preserve structured observability without logging chat bodies, full archives, secrets or per-message noise.

## Quality gates

- Add or update focused tests whenever behavior changes.
- Run the narrowest relevant checks while iterating.
- Run `npm run check` before finishing any material change. It covers frontend lint, types, tests and build; backend Ruff, Pyright and pytest; and a Cloudflare deployment dry run.
- Run `npm run format:check` when documentation, configuration or formatting changes.
- Do not weaken lint, type or test configuration merely to make a check pass.
- Never run `npm run deploy:worker` unless production deployment is explicitly authorized.
