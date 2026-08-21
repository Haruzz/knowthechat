# Know The Chat

Know The Chat is a public Twitch-chat guessing game. Enter a channel, choose a time range and chatter-pool size, then guess which familiar chatter wrote each archived message. The homepage headline is **“How well do you know your chat?”**

The application deliberately has only two routes:

- `/` — the complete setup, loading, game, and results interface.
- `/api/public-archive` — a `POST` endpoint that finds, filters, ranks, and returns public archived messages.

There is no Twitch login, ChatGPT login, EventSub connection, database, or application environment-variable setup. Archive availability depends entirely on independent public providers.

## Beginner setup (Windows and VS Code)

Install [Node.js 22.13 or newer](https://nodejs.org/), Git, and VS Code. Clone the GitHub repository, open its folder in VS Code, accept the recommended extensions, and run this in the integrated PowerShell terminal:

```powershell
npm install
npm run dev
```

Open the local address printed by Vinext. The npm commands are cross-platform: they do not use Unix-only inline environment assignments. Wrangler and Miniflare keep their non-secret development files under the ignored `.wrangler/` directory.

VS Code uses the repository TypeScript version, formats on save, offers explicit ESLint fixes on save, and uses LF line endings. Use **Terminal → Run Task** for development, linting, type-checking, tests, builds, or the full check.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Vinext/Vite development server. |
| `npm run lint` | Run the strict ESLint configuration; warnings fail the command. |
| `npm run lint:fix` | Apply safe automatic ESLint fixes, then reject remaining warnings. |
| `npm run typecheck` | Run strict TypeScript checking without writing output. |
| `npm test` | Build production output and test rendered HTML and the route surface. |
| `npm run build` | Create the Cloudflare Worker-compatible production bundle in `dist/`. |
| `npm run check` | Run lint, type-checking, tests, and the production build used by tests. |

Before opening or updating a pull request, run `npm run check` from a clean install.

## Architecture and project structure

This is a Vinext application using React 19, Vite, and a Cloudflare Worker entry point.

```text
app/
  layout.tsx                    site-wide metadata and document shell
  page.tsx                      homepage route
  who-said-it.tsx               browser UI, rounds, keyboard input, local history
  api/public-archive/route.ts   public archive aggregation and selection pipeline
build/sites-vite-plugin.ts      copies Sites metadata into production output
worker/index.ts                 Cloudflare Worker and image-optimization entry point
tests/rendered-html.test.mjs    production-render and route-surface checks
.openai/hosting.json            ChatGPT Sites project metadata
.vscode/                        editor recommendations, settings, and tasks
vite.config.ts                  Vinext, Sites, and Cloudflare build configuration
```

The browser posts the channel, lookback, and chatter-pool choice to `/api/public-archive`. The endpoint returns ranked chatters and candidate quotes. The browser makes balanced three-choice rounds, prioritizes unseen quote IDs, renders emotes, plays optional answer sounds, and supports number keys plus Enter/Space. State is intentionally ephemeral except for local seen-message history.

## Public archive providers

The endpoint first asks `logs.zonian.dev` for the channel’s available historical dates. It samples dates across the requested range (more dates for wider ranges), fetches JSON logs, and caches finished days longer than the current day at the Cloudflare fetch layer.

If no historical messages are available, it falls back to recent-message mirrors:

- `recent-messages.robotty.de`
- `recent-messages.zneix.eu`
- `logs.zonian.dev/rm`

These are public, independent services, not Twitch APIs owned by this project. They may be incomplete, delayed, unavailable, rate-limited, or cover only some channels and dates. The game sends no Twitch credentials and must fail with a clear “no public archive” response when no provider supplies usable data.

## Filtering and quote selection

Raw IRC and historical JSON records are normalized into the same message shape. The server rejects malformed records, messages without stable message/user IDs, invalid timestamps, very short text, URLs, and messages outside the requested lookback.

Quality filtering removes:

- Known bot accounts and names that look like bots.
- Chat commands beginning with common command prefixes.
- Twitch subscription, gift, raid, ritual, badge, charity, and other event notices, including system messages.
- Mentions, generic one-line reactions, repeated-character spam, and text with too little meaningful content.
- Automated watch-time, points, rank, song, follow-age, match-history, roster, and stat-card output.
- Exact duplicate IDs, normalized duplicate text, and near-duplicates with heavy meaningful-word overlap.

Native Twitch emote positions are removed before prose-quality scoring so emote-only messages do not look like strong quotes. Recognizability then rewards useful length, varied words, punctuation, numbers, and distinctive phrasing. Only sufficiently strong quotes enter the game.

## Chatter ranking and duplicate prevention

Messages are grouped by Twitch user ID. A chatter’s score combines usable-message count, active days, active months, and small subscriber/VIP/moderator signals. Multi-day archives require activity on at least two days. A chatter needs at least three accepted messages, and only the selected top 25, 50, or 100 chatters are eligible.

Round generation caps quotes per author, rotates through authors, avoids consecutive repeats when possible, and chooses decoys with nearby activity scores while varying average message length. Server-side ID/text/near-duplicate sets prevent repeated source material within a response.

The browser additionally stores up to 500 seen message IDs per channel in `localStorage` under `knowthechat-seen:<channel>`. Fresh messages are placed before previously seen ones; older messages are still a fallback if an archive is too small. This history stays in that browser profile, is not synced, can be cleared by the user, and is never sent to a database.

## Emotes

Native Twitch emotes use their IRC character ranges and Twitch’s public CDN. The endpoint also builds channel/global catalogs from 7TV, BetterTTV, and FrankerFaceZ and adds non-overlapping third-party emote spans. The browser makes a best-effort 7TV refresh as a resilience measure. Provider failure never blocks the text game; an unavailable image can simply appear broken or as its alt text.

## Known limitations

- Public archives are unofficial and can disappear or change without notice.
- Deleted, moderated, missing, or never-archived chat cannot be recovered.
- Sampling large histories favors coverage over exhaustive retrieval.
- Heuristic filters can reject good jokes or admit automated-looking text.
- Bot-name detection and English-oriented patterns are imperfect for other languages and communities.
- Display names, roles, profile images, and third-party emotes may have changed since a message was sent.
- Browser-local history is device/profile specific and private browsing may discard it.

## GitHub workflow: source of truth

The GitHub repository is the source of truth for code and documentation. Work on a feature branch, keep changes focused, run `npm run check`, commit the exact tested files, push the branch, and use a draft pull request while work is under review. Merge only after checks and review pass. Never treat a Sites version as the canonical source snapshot.

GitHub and ChatGPT Sites **do not automatically synchronize**. Pushing or merging GitHub does not update the hosted site, and saving or deploying a Sites version does not update GitHub. A deliberate operator must ensure both systems refer to the same commit.

## ChatGPT Sites, Cloudflare, and the custom domain

`.openai/hosting.json` connects this checkout to its ChatGPT Sites project. It should contain only the Sites `project_id` and optional logical D1/R2 bindings. This app needs neither D1 nor R2, so both remain `null`; it also needs no runtime secrets or environment variables. The Sites build copies this file into `dist/.openai/hosting.json` and produces the Cloudflare Worker-compatible server bundle.

ChatGPT Sites owns saving and deploying site versions. Cloudflare runs the built Worker and serves assets. The custom domain `knowthechat.com` is represented in application metadata, while its DNS/custom-domain mapping is managed through the Cloudflare/Sites hosting controls—not by adding credentials or DNS secrets to this repository. DNS changes should preserve the records Sites instructs the owner to use; verify the domain, TLS, and canonical URL after an authorized deployment.

## Safe deployment process (do not skip)

Deployment is a separate, explicitly authorized operation. Completing a PR or pushing a branch is not permission to save or deploy a Sites version.

Before saving or deploying any Sites version, require every box below:

- [ ] Confirm the intended feature branch and review its complete diff.
- [ ] Run `npm ci` when validating from a fresh checkout.
- [ ] Run `npm run check` successfully without source changes afterward.
- [ ] Record `git rev-parse HEAD` as the exact tested commit SHA.
- [ ] Push that exact commit to GitHub and verify the remote branch resolves to the same SHA.
- [ ] Confirm the draft PR/merged commit contains that SHA and GitHub remains the source of truth.
- [ ] Package and save a new Sites version from that exact checked-out commit—never from an unrelated working tree or existing saved version.
- [ ] Compare the Sites version’s recorded commit SHA with the tested/pushed SHA before deployment.
- [ ] Obtain explicit deployment approval and confirm the intended access level and custom domain.
- [ ] Deploy that new verified version, then check `/`, `/api/public-archive` behavior, metadata, TLS, and the custom domain.

Incident warning: an incorrect old source snapshot was previously deployed as Sites version 35, and the correct site was restored from saved version 34. **Never deploy an existing or older Sites version as a fallback when a source push, version save, SHA comparison, or packaging step fails. Stop, leave the live site unchanged, fix the source/push problem, rerun every check, and create a new version from the exact pushed commit.**

This repository setup does not deploy the website.
