# Know The Chat

![Know The Chat](docs/assets/repository-social-preview.png)

Know The Chat is a Twitch chat guessing game. Play solo with streak celebrations or invite friends to a private, timed match using real public archived messages. React and the Python API share one Cloudflare Worker; a SQLite-backed Durable Object coordinates each multiplayer room.

**Play at [knowthechat.com](https://knowthechat.com).**

This is an unofficial community project. It is not affiliated with or endorsed by Twitch, Amazon, any featured streamer, or the public archive and emote providers it uses. See the [privacy notice](PRIVACY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Game modes

- **Solo:** choose a channel, archive period, chatter pool and game length. Five correct guesses ignite the screen edges; higher streaks unlock new celebrations. Track accuracy and your best streak, and toggle sound or effects. Reduced-motion preferences are respected.
- **Play with friends:** create a private room for 2–8 players and share its invite code or link. Room codes start hidden; copy the code or invite link without displaying it, or use Show/Hide to reveal it on stream. Choose 5, 10 or 20 rounds and a 15, 20 or 30 second timer. Everyone gets the same three choices. Correct answers earn 1,000 points plus up to 500 for speed; the host advances after each shared reveal. Rematches fetch fresh clues using the same channel, archive period and chatter pool, excluding recently played quote texts. Final standings stay visible while the new chat loads; if too few fresh clues are available or loading fails, the results remain and the host can retry or create another lobby.

Rooms expire after two hours. The default admission policy allows ten open rooms across the site, including waiting lobbies and final standings, with separate rolling limits on room preparation and new matches. A limit pauses the affected action and shows when to try again; existing matches continue. Self-hosters can change the [admission settings](docs/cloudflare.md#multiplayer-admission-limits).

Reloading the same browser tab restores your player session. Room updates arrive over hibernating WebSockets, with automatic reconnection and an HTTP fallback when needed; the server owns deadlines, scores and answer reveals. This mode is intended for casual matches with friends using public source material.

## Music and sound

Optional music plays in both modes: a relaxed lobby loop during setup and between matches, and a quieter shuffled playlist during gameplay. Each gameplay track plays once before the playlist repeats, and music continues across rounds. The last five seconds of an unanswered multiplayer round gently lift the music and add a short tick-tock cue each second. The countdown uses the SFX toggle and stops when you submit an answer. Streak jingles briefly lower the music. Music starts off; each player controls their own music toggle and volume separately from sound effects and visual effects. Preferences stay in that browser.

The gameplay playlist contains **Three Red Hearts - Penguin Town**, **Three Red Hearts - Sanctuary**, **Sketchbook 2025-12-11**, and **Sketchbook 2024-10-14**. The lobby uses **Super Retro Lounge**. These compressed tracks are served with the frontend and played locally, with no external music service. Tracks load only after music is enabled, playback waits for a browser interaction when required, and hidden tabs pause the music and countdown cues. Artist credits, source links and the CC0 license are included in [the audio notices](frontend/public/audio/CREDITS.md).

## Prerequisites

- Node.js 22.13 or newer
- Python 3.13
- [uv](https://docs.astral.sh/uv/)

Install everything from the repository root:

```bash
npm install
cd backend
uv sync
```

## Local development

From the repository root, start the backend and frontend in separate terminals.

Backend:

```bash
cd backend
uv run pywrangler dev
```

Frontend:

```bash
npm run dev
```

The backend listens on `127.0.0.1:8787`. Vite prints the frontend URL and proxies `/api/*` to the local Worker.

To serve a production frontend build through the local Worker:

```bash
npm run build
cd backend
uv run pywrangler dev
```

Then open `http://127.0.0.1:8787`.

## Python runtime types

The uv development dependencies already include `workers-runtime-sdk` and `pyodide-py` (via `workers-py`). Cloudflare supplies the `js` module inside its Python runtime; it is not a separate pip/uv package.

Pyright uses the checked-in definitions in `backend/typings/js/` for imports such as `WebSocketPair`, `WebSocketRequestResponsePair` and `AbortSignal`. Keeping this generated `.pyi` file in Git gives fresh checkouts and CI the same types without running the network-dependent generator first. `.gitattributes` marks it as generated so GitHub collapses its diff and excludes it from language statistics. Regenerate it after changing bindings, the compatibility date or flags:

```bash
npm run types:worker
```

This runs [Cloudflare's official `pywrangler types` generator](https://developers.cloudflare.com/workers/languages/python/basics/#types-and-autocompletion). The converter is pinned as an npm development dependency. On Windows, a scoped loader corrects its file-URL handling during generation; installed packages are not modified. The generated definitions are for development only and do not provide a native CPython implementation of Cloudflare's APIs.

Known lobby responses use shared field types, and the Python SDK's wrapped bindings use small protocols. Incoming JSON is validated before being exposed as those types. Keep `Any` limited to boundaries that truly have no known shape; `object` in Python and `unknown` in TypeScript require callers to narrow unknown data before use. Pyright also checks `backend/tests/test_editor_types.py` to catch regressions in representative header, socket, storage and lobby-field types.

## Local streak playground

Start the standalone playground from the repository root:

```bash
npm run dev:streaks
```

Open [http://127.0.0.1:5174](http://127.0.0.1:5174). No backend, Twitch channel or archive is needed. Use the milestone buttons to preview **On Fire (5)**, **Unstoppable (10)** and **Chat Legend (15+)**, including their sounds. Enable Music to audition **Lobby**, **Gameplay**, and **Final seconds**, adjust its volume, and hear the music dip beneath streak jingles. **Try 5-second countdown** auditions the tick-tock cue with or without music; a guess or celebration stops it early. Simulate correct guesses or a miss, replay a celebration, and toggle sound or visual effects. Reduced-motion preferences still apply. Stop the server with **Ctrl+C**.

This page has a separate development entry point in `frontend/playground/`, listens only on the local loopback interface, and is excluded from the normal production build. The game has no preview link or query-string switch; `?preview=streaks` no longer opens a playground.

## Validation

```bash
npm run check
```

This runs formatting, linting, type checks, tests, the frontend build, and a Cloudflare Worker dry run without deploying anything.

With the combined local Worker running, exercise two players against the real Durable Object runtime and public archive providers:

```bash
node scripts/smoke-multiplayer.mjs jaxstyle
node scripts/smoke-websockets.mjs jaxstyle
```

The smoke checks only accept localhost and create disposable five-round rooms. The WebSocket check verifies personalized pushes, heartbeats, reconnection and timer-driven reveals without polling. Use another archived channel as the argument if needed.

## Architecture

```text
Browser
  ├─ GET /*                    → Workers Static Assets → React + Vite
  ├─ POST /api/public-archive → Python Worker → public archives + emotes
  └─ /api/rooms/*            → Python Worker → one SQLite Durable Object per room
       ├─ creation / new match → shared admission Durable Object
       └─ /:code/events        → hibernating WebSocket updates
```

The frontend and API share one Cloudflare Worker and one origin. See the [architecture guide](docs/architecture.md) and [Cloudflare operations guide](docs/cloudflare.md) for details.

## CI/CD

GitHub Actions runs `npm run check` on pull requests. After a pull request is merged, Cloudflare Workers Builds builds and deploys `main`.

## Roadmap

Know The Chat is under active development. The [roadmap](ROADMAP.md) collects gameplay ideas and open product questions.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a substantial pull request. Report suspected vulnerabilities privately by following [SECURITY.md](SECURITY.md), and follow the project [code of conduct](CODE_OF_CONDUCT.md) in community spaces.

## License

Know The Chat is available under the [MIT License](LICENSE).
