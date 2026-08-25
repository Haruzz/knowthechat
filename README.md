# Know The Chat

Know The Chat is a Twitch chat guessing game. Its React single-page application asks a same-origin Cloudflare Python Worker for public archived messages, then builds the game entirely in the browser.

This is an unofficial community project. It is not affiliated with or endorsed by Twitch, Amazon, any featured streamer, or the public archive and emote providers it uses. See the [privacy and public-data notice](PRIVACY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Architecture

```text
Browser
  ├─ GET /*                    → Workers Static Assets → React + Vite
  └─ POST /api/public-archive → Python Worker
                                  ├─ Zonian archive-instance discovery
                                  ├─ trusted public log instances
                                  ├─ archive-first recent-message fallback
                                  └─ 7TV / BetterTTV / FrankerFaceZ
```

One Worker deployment owns `knowthechat.com` and `www.knowthechat.com`. Cloudflare serves the compiled frontend without invoking Python; `assets.run_worker_first: ["/api/*"]` sends API requests to Python first. The browser therefore keeps using `fetch("/api/public-archive")` with no CORS configuration.

See [the architecture guide](docs/architecture.md) and [Cloudflare operations guide](docs/cloudflare.md).

## Roadmap

Know The Chat is under active development. The [public roadmap and research
notes](ROADMAP.md) collect gameplay ideas, open product questions, and Twitch
streamers who have played the game. The roadmap is a backlog, not a commitment
to implement every item.

## Prerequisites

- Node.js 22.13 or newer
- Python 3.13
- [uv](https://docs.astral.sh/uv/)
- A Cloudflare login only for deployment; local development needs no production credentials

Install everything from the repository root:

```bash
npm install
uv sync --directory backend
```

`npm install` also registers the repository's Husky hooks. Before each commit,
lint-staged formats only the files included in that commit: Prettier handles
frontend and configuration files, while Ruff formats and fixes Python files.
Fixable changes are added back to the commit automatically; an unresolved lint
error stops the commit.

Useful formatting commands:

```bash
npm run precommit
npm run format
npm run format:check
npm run prepare # Reinstall the Git hooks if needed
```

## Local development

Use two terminals:

```bash
uv run --directory backend pywrangler dev
```

```bash
npm run dev:frontend
```

The backend listens on `127.0.0.1:8787`. Vite prints the frontend URL and proxies `/api/*` to that backend, so browser requests remain same-origin from the application's perspective. Set `KNOWTHECHAT_BACKEND_ORIGIN` before starting Vite only if the backend uses another origin.

## Validation

```bash
npm run check
```

That command runs frontend lint, strict TypeScript checking, frontend tests and build; backend Ruff, Pyright and pytest; then a combined Cloudflare deployment dry run.

Useful narrower commands:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run check:backend
npm run deploy:dry-run
```

The deployment dry run validates the Worker bundle without authenticating to or changing a Cloudflare account. Production deployment is maintainer-only and deliberately absent from the normal contributor workflow. To deploy a fork to your own Cloudflare account, follow [the self-hosting guide](docs/self-hosting.md).

## CI/CD

GitHub Actions validates pull requests:

1. **Test**
   - **Pre-commit:** Prettier formatting plus frontend ESLint and backend Ruff
   - **Type checks:** strict TypeScript and Pyright
   - **Tests:** Vitest and pytest
2. **Build:** creates the Vite production bundle and performs a complete Cloudflare deployment dry run

Pull requests therefore have to pass both jobs before they are ready to merge. After a merge or direct push to `main`, Cloudflare Workers Builds checks out that commit, builds the frontend, and deploys the combined Worker. Production credentials stay inside Cloudflare; GitHub Actions does not deploy and does not require Cloudflare secrets.

Pull requests from forks run with read-only repository permissions and receive no production credentials. Only maintainers can merge to the protected `main` branch, which is the production deployment boundary.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a substantial pull request. Report suspected vulnerabilities privately by following [SECURITY.md](SECURITY.md), and follow the project [code of conduct](CODE_OF_CONDUCT.md) in community spaces.

## License

Know The Chat is available under the [MIT License](LICENSE).
