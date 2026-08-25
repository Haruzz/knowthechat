# Know The Chat

Know The Chat is a Twitch chat guessing game. Its React single-page application asks a same-origin Cloudflare Python Worker for public archived messages, then builds the game entirely in the browser.

**Play at [knowthechat.com](https://knowthechat.com).**

This is an unofficial community project. It is not affiliated with or endorsed by Twitch, Amazon, any featured streamer, or the public archive and emote providers it uses. See the [privacy notice](PRIVACY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

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

## Validation

```bash
npm run check
```

This runs formatting, linting, type checks, tests, the frontend build, and a Cloudflare Worker dry run without deploying anything.

## Architecture

```text
Browser
  ├─ GET /*                    → Workers Static Assets → React + Vite
  └─ POST /api/public-archive → Python Worker
                                  ├─ public chat archives
                                  └─ emote providers
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
