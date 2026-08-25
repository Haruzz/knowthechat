# Contributing to Know The Chat

Thanks for helping improve Know The Chat. Bug reports, focused fixes, tests,
documentation, accessibility improvements, and gameplay ideas are welcome.

## Before starting

- Search existing issues and pull requests before opening a duplicate.
- Open an issue before a large behavioral or architectural change so the scope
  can be agreed first.
- Do not include private Twitch data, credentials, access tokens, or chat logs
  that are not already intentionally public.

## Local development

Install Node.js 22.13 or newer, Python 3.13, npm, and uv. From the repository
root:

```bash
npm install
cd backend
uv sync
```

From the repository root, run the backend and frontend in separate terminals.

Backend:

```bash
cd backend
uv run pywrangler dev
```

Frontend:

```bash
npm run dev
```

Local development uses only public upstream services.

## Pull requests

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Preserve accessibility, keyboard interaction, response-size bounds, upstream
   timeouts, trusted-host checks, and the same-origin `/api/public-archive`
   contract.
4. Run `npm run check`.
5. Explain the user-visible change and the checks you ran in the pull request.

## Reporting security problems

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md) instead.
