# Contributing to Know The Chat

Thanks for helping improve Know The Chat. Bug reports, focused fixes, tests,
documentation, accessibility improvements, and gameplay ideas are welcome.

## Before starting

- Search existing issues and pull requests before opening a duplicate.
- Open an issue before a large behavioral or architectural change so the scope
  can be agreed first.
- Do not include private Twitch data, credentials, access tokens, or chat logs
  that are not already intentionally public.
- Keep production deployment and domain changes out of contributions unless a
  maintainer explicitly requests them.

## Local development

Install Node.js 22.13 or newer, Python 3.13, npm, and uv. From the repository
root:

```bash
npm install
uv sync --directory backend
```

Run the backend and frontend in separate Git Bash terminals:

```bash
uv run --directory backend pywrangler dev
```

```bash
npm run dev:frontend
```

Local development uses only public upstream services and does not require
production credentials.

## Pull requests

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Preserve accessibility, keyboard interaction, response-size bounds, upstream
   timeouts, trusted-host checks, and the same-origin `/api/public-archive`
   contract.
4. Run `npm run check` and `npm run format:check`.
5. Explain the user-visible change and the checks you ran in the pull request.

Pull requests run untrusted code in a read-only GitHub Actions workflow. They do
not receive production credentials and cannot deploy the application.

## Reporting security problems

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md) instead.
