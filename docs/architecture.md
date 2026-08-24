# Architecture

## What runs where

The browser runs the React application from `frontend/`. React owns setup, loading, game and results state; keyboard controls; sounds; local seen-message history; streamer profile lookup; and rendering Twitch and third-party emotes. TypeScript catches UI contract mistakes before the browser receives the code.

Cloudflare runs `backend/src/main.py` in a Python Worker. Cloudflare's ASGI adapter invokes the FastAPI application directly inside the Worker isolate; there is no Uvicorn process, socket listener, filesystem-based serving, subprocess, or conventional Linux server. FastAPI validates and routes the public API request, while the existing service asks public archive/emote providers for data, filters and ranks messages, and returns the response model.

Workers Static Assets stores the Vite output separately from Python modules. Requests for frontend files normally never invoke Python.

## Request lifecycle

```text
POST /api/public-archive
  → bounded ASGI body read
  → FastAPI + Pydantic PublicArchiveRequest validation
  → PublicArchiveService
      → discover trusted public log instances through Zonian
      → merge the instances' available archive dates
      → reject an unavailable calendar year before archive downloads
      → sample at most 12 dates from the selected period
      → fetch and parse historical messages
      → use the historical archive exclusively when it exists
      → use recent providers only when no archive exists and the period is rolling or current-year
      → filter bots/events/low-quality messages
      → remove exact and near duplicates
      → rank recognizable chatters
      → fetch and merge emote catalogs
      → score and select quotes
  → Pydantic PublicArchiveResponse serialization
  → JSON response with Cache-Control: no-store
```

Historical and recent messages are never mixed. A confirmed missing channel archive can trigger the recent-message fallback for rolling periods and the current calendar year; past calendar years remain historical-only. The response identifies the chosen source as `historical` or `recent`, and the frontend labels recent-only games. A historical-provider failure returns 503 instead of silently changing the game to recent chat. Individual recent and emote provider failures remain isolated when another provider succeeds. If a selected year has no advertised dates, the API returns a specific 404 before downloading archive bodies. If no source provides usable data, the API returns the generic 404 error contract.

## Code boundaries

- `fastapi_app.py` owns API routing, bounded request buffering and preserved error responses.
- `api_models.py` uses Pydantic only for untrusted request data and the public response contract.
- `domain/` contains dataclasses and pure functions for normalization, parsing, filtering, scoring, sampling, ranking and duplicate detection.
- `providers/` contains provider-specific URLs and response parsing.
- `providers/protocols.py` defines small structural interfaces. Fakes satisfy them without inheritance.
- `PublicArchiveService` receives providers through its constructor and orchestrates them.
- `main.py` passes Cloudflare requests to FastAPI through `asgi.fetch()` and deliberately contains no filtering or ranking rules.

`Protocol` is used because archive and emote sources are replaceable dependencies and tests need small fakes. There are no ABCs: the implementations share no state or algorithm that would justify runtime inheritance. Constructor injection keeps wiring visible and avoids a DI framework.

## Repository tree

```text
frontend/
  public/
  src/
    App.tsx
    App.test.tsx
    main.tsx
    styles.css
  index.html
  package.json
  vite.config.ts
  vitest.config.ts
  wrangler.jsonc
backend/
  src/
    main.py
    api_models.py
    fastapi_app.py
    domain/
    providers/
    runtime/
    services/
  tests/
    test_domain.py
    test_fastapi_app.py
    test_providers.py
    test_service.py
  pyproject.toml
  uv.lock
  pylock.toml
  wrangler.jsonc
docs/
  architecture.md
  cloudflare.md
AGENTS.md
README.md
package.json
package-lock.json
```
