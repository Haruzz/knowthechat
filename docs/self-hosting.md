# Self-hosting on Cloudflare

The checked-in production configuration names the maintainers' Worker and custom
domains. Those names are public configuration, not credentials, and do not grant
access to the production Cloudflare account.

To deploy a fork, use your own Cloudflare account and domain configuration:

1. Fork or clone the repository.
2. Change `name` and `routes` in `backend/wrangler.jsonc`. Remove `routes` and set
   `workers_dev` to `true` if you only want a `workers.dev` hostname.
3. Keep `assets.run_worker_first` limited to `/api/*`.
4. Authenticate Wrangler to your own Cloudflare account.
5. Build and deploy from the repository root:

   ```bash
   npm install
   uv sync --directory backend
   npm run build
   npm run deploy:worker
   ```

The repository does not contain the maintainers' Cloudflare token, account ID,
DNS credentials, or GitHub deployment secrets. Running these commands while
authenticated to another account cannot deploy to the maintainers' Worker or
domains.

Before operating a public fork, review Cloudflare usage limits, upstream-provider
terms, the privacy notice, log retention, and abuse controls appropriate for your
traffic.
