# Architecture

## What runs where

The browser runs the React application from `frontend/`. React owns setup, loading, game and results state; keyboard controls; sounds; local seen-message history; streamer profile lookup; and rendering Twitch and third-party emotes. TypeScript catches UI contract mistakes before the browser receives the code.

In multiplayer, React renders a player-specific snapshot from the server. The server owns membership, the host, the deck, deadlines, locked guesses, scoring, and round transitions. The solo game's existing browser-owned state and `POST /api/public-archive` contract remain supported.

Cloudflare runs `backend/src/main.py` in a Python Worker. Cloudflare's ASGI adapter invokes the FastAPI application directly inside the Worker isolate; there is no Uvicorn process, socket listener, filesystem-based serving, subprocess, or conventional Linux server. FastAPI validates and routes the public API request, while the existing service asks public archive/emote providers for data, filters and ranks messages, and returns the response model.

Workers Static Assets stores the Vite output separately from Python modules. Requests for frontend files normally never invoke Python.

## Multiplayer lobbies

One Python `GameRoom` Durable Object coordinates each six-character lobby code through the `GAME_ROOMS` binding. Its SQLite storage contains one bounded JSON snapshot; creating a lobby stores only its selected 5, 10, or 20 rounds, not the downloaded archive. A shared `RoomAdmission` Durable Object through `ROOM_ADMISSION` coordinates room capacity and new-match limits. No D1, KV, second Worker, or additional public API origin is required.

```text
POST /api/rooms
  -> bounded body and Pydantic settings validation
  -> hash the network key and reserve capacity through ROOM_ADMISSION
  -> PublicArchiveService fetches and selects real chat on the server
  -> server generates a private deck, three choices per round, and opaque round IDs
  -> GAME_ROOMS.getByName(code).initialize(private state)
       -> activate the reservation with the fixed room expiry
       -> persist the initial private room state
  -> host bearer token and waiting-room snapshot

POST /api/rooms/:code/join
  -> validate display name and room code
  -> room validates capacity, unique name, and waiting phase
  -> member bearer token and player-specific snapshot

GET /api/rooms/:code/events (WebSocket upgrade)
  -> origin and session subprotocol validation before acceptance
  -> native Worker forwarding to the same GameRoom, outside ASGI
  -> hibernating socket with player ID attachment and personalized snapshots

GET /api/rooms/:code (fallback); POST /api/rooms/:code/{start,guess,next,rematch,leave}
  -> bearer token and Pydantic command validation
  -> room loads SQLite state, applies deadlines, authenticates, mutates, and saves
  -> player-specific snapshot with Cache-Control: no-store
```

Archive I/O finishes before initializing the room object. Room creation and new matches require admission before they commit. Ordinary gameplay, guesses and heartbeats do not contact the shared admission object. RPC calls use JSON strings across the Python/JavaScript binding boundary. SQLite remains authoritative for room state and the admission ledger, so both recover their decisions after eviction.

Each round lasts 15, 20, or 30 seconds. Clients render the countdown from epoch-millisecond `deadline` and `serverNow`, but only the server clock decides whether a guess is on time. A Durable Object alarm closes the round without needing a connected browser; every command also applies a passed deadline before accepting input. A round reveals early once all current players answer. Correct guesses earn 1,000 points plus up to 500 for speed; incorrect or missing guesses earn zero. Scores and streaks are applied together at reveal, preventing another player's changing score from disclosing the answer. Before reveal, a player sees only their own choice and whether other players have answered; no answer, future deck, raw archive quote IDs, or token hashes enter the public snapshot.

The host starts the match, advances from the reveal screen, and starts a rematch. Advancing after the last reveal shows the final standings. A rematch returns everyone to the waiting room, clears scores and streaks, and shuffles the same saved chat with fresh round IDs and choice order. It does not refetch the archive. Explicit host departure transfers hosting to the next member. New players may join only while waiting, with a maximum of eight players and unique display names.

Lobbies have a fixed two-hour lifetime. Members inactive for 15 minutes are removed, with host transfer when necessary; HTTP presence updates are throttled, and connected players' presence is recovered from automatic WebSocket ping timestamps before applying timeouts. The earliest round deadline, membership timeout, or room expiry schedules the next alarm. Empty and expired rooms use `deleteAll()` to remove stored data and alarms. Requests for nonexistent codes read schema metadata without creating tables, stored values, or alarms.

The primary transport uses same-origin hibernating WebSockets. The native Worker forwards the upgrade directly to the room so it can use `ctx.acceptWebSocket()`; the ordinary ASGI WebSocket adapter would keep the object awake. Each connection attaches only its player ID. On every committed change and alarm-driven reveal, the object sends a separate redacted snapshot to each current member. A persisted, increasing revision prevents a delayed HTTP response from overwriting newer pushed state in the browser.

The browser offers `knowthechat.v1` and `session.<token>` as WebSocket subprotocols; the response selects only `knowthechat.v1`. Tokens never enter URLs. Upgrades validate the same origin and existing membership before acceptance, with at most two sockets per player and sixteen per room. Leaving or expiring a room closes its sockets.

Browser heartbeat messages receive a static `ping`/`pong` auto-response from Cloudflare without waking Python. There are no server timer loops. Socket attachments and auto-response timestamps remain available after hibernation; SQLite remains the game authority. Clients reconnect with bounded backoff and fall back to HTTP state requests when WebSockets are unavailable. A healthy socket stops fallback polling.

The first multiplayer version used polling to simplify its transport; this was an implementation choice, not a Workers plan restriction. Python hibernation support is documented in [Cloudflare's WebSocket guide](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Multiplayer admission

The shared admission object applies four configurable limits: ten open rooms; 100 admitted archive preparations in a rolling 24-hour window; 100 new-match admissions in a rolling 24-hour window; and three admitted preparations per network key in a rolling 60-second window. Waiting rooms and final standings occupy capacity until the room closes or expires. Requests denied before preparation do not consume preparation records. Once admitted, a failed archive preparation still counts toward its rolling limit.

Room creation reserves a slot before fetching any archive. The preparation timeout is 90 seconds; an unfinished reservation expires after two minutes. A completed room keeps its slot until its fixed two-hour expiry or closure, including departure of the last member. Cleanup uses scheduled alarms and expiry checks, so an interrupted preparation does not hold capacity indefinitely.

The first start reserves a match admission. A rematch reserves the next match before clearing the previous results; the following start reuses that admission rather than counting the same match twice. Admission identifiers make repeated checks for the same match idempotent. If a check is unavailable or denied, the new action does not proceed; existing guesses, reveals and connected games continue normally. The browser displays a retry delay when supplied, disables only the rejected action until that delay expires, and never automatically retries a creation or command.

The per-network ledger stores only a SHA-256 network key and admission timestamp, for 60 seconds. This key is pseudonymous, not anonymous; unhashed IP addresses are not persisted in admission storage. Preparation and match records contain reservation identifiers and timestamps for their 24-hour windows. Active reservations retain only the lifecycle data needed to release capacity. Requests and alarms prune expired records.

Rooms created before admission reservations were introduced can finish their current game. Starting a new game or rematch from a legacy room requires creating a fresh lobby.

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
- `main.py` forwards lobby event upgrades natively and passes other Cloudflare requests to FastAPI through `asgi.fetch()`; it contains no game, filtering or ranking rules.
- `room_models.py` and `room_routes.py` validate and route the multiplayer HTTP boundary through an injectable `RoomGateway` protocol.
- `services/rooms.py` fetches and generates private decks; `services/room_commands.py` dispatches room actions; `domain/rooms.py` owns deterministic game rules and redacted snapshots.
- `runtime/room_events.py` validates and forwards native event upgrades. `runtime/rooms.py` adapts the Cloudflare binding, SQLite persistence, hibernating sockets and alarms. `runtime/admission.py` persists shared reservations and rolling counters; `domain/admission.py` defines the policy settings and gateway protocol. `main.py` exports `GameRoom` and `RoomAdmission` for Wrangler.

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
