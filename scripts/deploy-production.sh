#!/usr/bin/env bash
set -euo pipefail

if [[ "${KNOWTHECHAT_PRODUCTION_DEPLOY:-}" != "1" ]]; then
  echo "Production deployment is maintainer-only."
  echo "Set KNOWTHECHAT_PRODUCTION_DEPLOY=1 after verifying the target Cloudflare account."
  exit 2
fi

npm run build
npm run deploy:worker
