# Development

This guide covers running and validating Know The Chat locally. Read [Architecture](architecture.md) for the code boundaries and [Cloudflare operations](cloudflare.md) for deployment. Run commands from the repository root unless a block explicitly changes directory. On Windows, use Git Bash; the examples below use Bash syntax.

## Prerequisites

- Node.js 22.13 or newer and npm.
- Python 3.13 (the backend requires `>=3.13,<3.14`).
- [uv](https://docs.astral.sh/uv/getting-started/installation/), installed for your user and available in a fresh shell.
- Git and internet access for dependencies and public archive/emote services.

No Twitch account, provider API key, or production Cloudflare credential is required for local gameplay. The local Worker simulates the Durable Object bindings; public archive requests still use real external services.

## Installation

From a fresh checkout:

```bash
npm install
uv sync --project backend
```

The root npm workspace installs frontend dependencies and the Husky hook. For the same locked dependency installation as CI, use:

```bash
npm ci
uv sync --project backend --locked --dev
```

Repository commands use [scripts/with-uv.mjs](../scripts/with-uv.mjs). It first uses installed `uv` (including the usual user-local location). If missing on Linux, it bootstraps pinned uv 0.12.5 into the user's local bin directory; this supports CI/Workers Builds. On Windows/macOS it reports a missing installation instead of installing one. It does not move development into a cloud environment.

Do not hand-edit generated `frontend/dist`, virtual environments, `backend/python_modules`, or Wrangler/cache output.

## Frontend and backend startup

Use two terminals. Start the Python Worker in the first:

```bash
cd backend
uv run pywrangler dev
```

Start Vite from the repository root in the second:

```bash
npm run dev
```

Open the frontend URL printed by Vite. The backend listens on `http://127.0.0.1:8787`. [Vite's proxy](../frontend/vite.config.ts) forwards `/api/*`, including WebSocket upgrades, to the local Worker. It preserves the original host (`changeOrigin: false`) for room origin checks. To use a different backend port:

```bash
KNOWTHECHAT_BACKEND_ORIGIN=http://127.0.0.1:8788 npm run dev
```

`pywrangler dev` runs Python through Cloudflare's local runtime; a standalone Uvicorn process is not the supported development backend. Local SQLite state and admission counters persist across restarts. Unit tests run without either server.

## Production-style local Worker

Build the frontend, then start the combined Worker:

```bash
npm run build
cd backend
uv run pywrangler dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). This exercises static assets, SPA navigation, Python routes, and room WebSockets on one origin using `backend/wrangler.jsonc`. Rebuild after frontend changes in this mode. If a local Worker already occupies port 8787, stop it before starting another.

`frontend/wrangler.jsonc` supports frontend development/builds only. The production deployment target is always the backend configuration; see [deployment and rollback](cloudflare.md#deployment-and-rollback).

## Python runtime types

The uv development dependencies already include `workers-runtime-sdk` and `pyodide-py` (via `workers-py`). Cloudflare supplies the `js` module inside its Python runtime; it is not a separate pip/uv package.

Pyright uses the checked-in definitions in `backend/typings/js/` for imports such as `WebSocketPair`, `WebSocketRequestResponsePair` and `AbortSignal`. Keeping this generated `.pyi` file in Git gives fresh checkouts and CI the same types without running the network-dependent generator first. `.gitattributes` marks it as generated so GitHub collapses its diff and excludes it from language statistics. Regenerate it after changing bindings, the compatibility date or flags:

```bash
npm run types:worker
```

This runs [Cloudflare's official `pywrangler types` generator](https://developers.cloudflare.com/workers/languages/python/basics/#types-and-autocompletion). The converter is pinned as an npm development dependency. On Windows, a scoped loader corrects its file-URL handling during generation; installed packages are not modified. The generated definitions are for development only and do not provide a native CPython implementation of Cloudflare's APIs.

Known lobby responses use shared field types, and the Python SDK's wrapped bindings use small protocols. Incoming JSON is validated before being exposed as those types. Keep `Any` limited to boundaries that truly have no known shape; `object` in Python and `unknown` in TypeScript require callers to narrow unknown data before use. Pyright also checks `backend/tests/test_editor_types.py` to catch regressions in representative header, socket, storage and lobby-field types.

The audio preparation scripts declare pinned `numpy` and `soundfile` dependencies in their inline uv metadata. Running `uv run scripts/prepare-music.py` creates an isolated environment for that script; the editor uses `backend/.venv` instead. The same packages are included in the project's development dependencies so imports and navigation also work in the editor. After pulling changes, run `uv sync --project backend` and select `backend/.venv/Scripts/python.exe` in VS Code on Windows (`backend/.venv/bin/python` on macOS/Linux). Pyright checks the audio scripts as part of `npm run check`. These development packages are excluded from the Python Worker bundle; normal game builds use the committed audio files.

## Validation and checks

Before a material change is finished:

```bash
npm run check
```

This checks Prettier and Ruff formatting, runs frontend ESLint and backend Ruff lint, checks TypeScript and Pyright, runs Vitest and pytest, builds the frontend, and performs `pywrangler deploy --dry-run`. It does not deploy the application. GitHub Actions runs the same command on pull requests and manual dispatch.

Use narrower checks while iterating:

| Command (repository root)                                                                       | Purpose                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npm run lint`                                                                                  | Frontend and backend lint.                             |
| `npm run typecheck`                                                                             | TypeScript and Python type checks.                     |
| `npm run test`                                                                                  | Both test suites.                                      |
| `npm run test -w frontend -- src/PartyGame.live.test.tsx`                                       | Focused browser multiplayer tests.                     |
| `uv run --directory backend pytest -q tests/test_room_runtime.py tests/test_fresh_rematches.py` | Focused room/deadline/rematch tests.                   |
| `npm run build`                                                                                 | TypeScript check and frontend build.                   |
| `npm run deploy:dry-run`                                                                        | Frontend build and Worker bundling validation.         |
| `npm run format`                                                                                | Format the repository (writes files; review the diff). |

The [pre-commit hook](../.husky/pre-commit) runs lint-staged formatting/lint fixes on staged files. It does not replace `npm run check`. Production deployment is a separate operation; `npm run deploy:worker` is not a local validation command.

## Smoke tests

With the combined local Worker running, exercise two players against the real Python Durable Object runtime and public archive providers:

```bash
node scripts/smoke-multiplayer.mjs jaxstyle
node scripts/smoke-websockets.mjs jaxstyle
```

Run them sequentially. Both accept localhost only, create disposable five-round rooms, and use `http://127.0.0.1:8787` by default. Another archived channel can replace `jaxstyle`; `KNOWTHECHAT_BACKEND_ORIGIN` can select a different local origin. They require enough usable public chat for fresh rematches and consume local admission allowances. Successful live responses need not contain identical sampled quotes.

- [HTTP multiplayer smoke](../scripts/smoke-multiplayer.mjs) checks joining, host permissions, redacted answers/guesses, scoring, a full match, rematch, stale-guess rejection, deadline handling, host transfer, and empty-room cleanup.
- [WebSocket smoke](../scripts/smoke-websockets.mjs) checks native upgrades/origins, personalized pushes, runtime heartbeat replies, reconnection, and alarm-driven reveals without polling.

Live failures may reflect provider availability or retained local admission counters. These checks are separate from the deterministic test suites in `npm run check`.

### Local admission smoke test

Use a fresh local persistence directory for each run, because rolling counters
survive restarts. In one terminal, start an isolated Worker with deliberately
small test limits:

```bash
cd backend
uv run pywrangler dev --port 8788 --persist-to .wrangler/admission-smoke-$(date +%s) \
  --var ROOM_MAX_OPEN:1 --var ROOM_PREPARATIONS_PER_DAY:3 \
  --var ROOM_MATCHES_PER_DAY:2 --var ROOM_CREATIONS_PER_MINUTE:3
```

In another terminal at the repository root:

```bash
node scripts/smoke-admission.mjs jaxstyle
```

The script accepts localhost only and uses real public archives. It checks full
capacity, initial match and fresh-rematch admission, preserved results after a denied
rematch, capacity release, and rolling preparation counts after room deletion.
The three preparation slots cover the initial room, its rematch and a new room.
Stop this isolated server when finished; normal development uses the configured
defaults.

## Local streak playground

Start the standalone playground from the repository root:

```bash
npm run dev:streaks
```

Open [http://127.0.0.1:5174](http://127.0.0.1:5174). No backend, Twitch channel or archive is needed. Use the milestone buttons to preview **On Fire (5)**, **Unstoppable (10)** and **Chat Legend (15+)**, including their sounds. Use the music controls to audition **Lobby** or **Gameplay**, adjust volume, and hear the music dip beneath streak jingles. **Final seconds** and **Try 5-second countdown** both silence the music and run the five tick-tock cues; a guess or celebration stops them early. The preview waits briefly for browser audio permission before starting, and SFX must be on to hear the countdown. **Game over · applause** auditions the final-results applause with music silent; click it again to replay. Simulate correct guesses or a miss, replay a celebration, and toggle sound or visual effects. Reduced-motion preferences still apply. Stop the server with **Ctrl+C**.

This page has a separate development entry point in `frontend/playground/`, listens only on the local loopback interface, and is excluded from the normal production build. The game has no preview link or query-string switch; `?preview=streaks` no longer opens a playground.

## Audio and development tooling

Normal builds use the committed assets in `frontend/public/audio/`. To regenerate them intentionally from their original sources:

```bash
uv run scripts/prepare-music.py
uv run scripts/prepare-countdown.py
uv run scripts/prepare-applause.py
```

These optional scripts verify source hashes and size/sample constraints before writing assets. They use pinned inline uv dependencies (`numpy` and `soundfile`); no external music service or audio build step runs in production. Retain attribution and license files when updating assets. See [audio credits](../frontend/public/audio/CREDITS.md) for source URLs, checksums, conversion settings, and the separate CC0 and CC BY 3.0 licenses.

### Playback behavior

Optional music plays in both modes: a relaxed lobby loop during setup and between matches, and a quieter shuffled playlist during gameplay. Each gameplay track plays once before the playlist repeats, and music continues across rounds. Music goes silent for the last five seconds of a multiplayer round, leaving a distinct tick-tock cue each second for players who still need to answer. The countdown uses the SFX toggle and stops when you submit an answer. Music stays silent while the leaderboard or solo results are shown. A short applause recording plays once when solo results open or the final party round reveals its leaderboard. It uses the SFX toggle, preserves normal answer/streak feedback, and stops on a new game, rematch, leaving, muting SFX, or hiding the tab. Restoring an already completed party game does not replay it. Streak jingles briefly lower the music during play. Music is off by default for first-time visitors, with a starting volume of 35% when enabled. Each player controls their own music toggle and volume separately from sound effects and visual effects. Preferences stay in that browser, including a saved choice to turn music on or off.

The gameplay playlist contains **Three Red Hearts - Penguin Town**, **Three Red Hearts - Sanctuary**, **Sketchbook 2025-12-11**, and **Sketchbook 2024-10-14**. The lobby uses **Super Retro Lounge**. These compressed tracks are served with the frontend and played locally, with no external music service. Tracks load only after music is enabled, playback waits for a browser interaction when required, and hidden tabs pause the music and countdown cues. Artist credits, source links and licenses are included in [the audio notices](../frontend/public/audio/CREDITS.md) and the game's **Audio credits** page. Music and clock cues use CC0; **Applause** by Blender Foundation, edited by LeeZH, uses CC BY 3.0. All assets ship with the frontend; applause preloads with SFX and never delays the results screen.
