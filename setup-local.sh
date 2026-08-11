#!/usr/bin/env bash
# Pull env vars off the Render service into a local .env, then run the app.
#
#   ./setup-local.sh srv-XXXXXXXXXXXX oregon
#
# Find the service ID in the Render dashboard URL for esperion-inventory-dashboard.
# Requires an SSH key registered on your Render account (Account Settings -> SSH Keys).

set -euo pipefail
cd "$(dirname "$0")"

SERVICE_ID="${1:?usage: ./setup-local.sh <srv-id> [region]}"
REGION="${2:-oregon}"
KEYS='^(MYOB_|DATABASE_URL|DASHBOARD_ACCESS_KEY|TOKEN_ENCRYPTION_KEY|SYNC_|TARGET_COVER_WEEKS)'

echo "==> Pulling env from ${SERVICE_ID} via Render SSH"
ssh -o StrictHostKeyChecking=accept-new \
    "${SERVICE_ID}@ssh.${REGION}.render.com" printenv \
  | grep -E "$KEYS" | sort > .env.render

if [ ! -s .env.render ]; then
  echo "!! No matching vars came back. Check the service ID / region." >&2
  exit 1
fi
echo "    got $(wc -l < .env.render) vars"

echo "==> Building .env for local run"
{
  echo "PORT=3000"
  echo "APP_BASE_URL=http://localhost:3000"
  echo "DATA_DIR=.data"
  cat .env.render
} > .env

# Render's DATABASE_URL is the *internal* hostname (bare dpg-... host), which only
# resolves inside Render's private network. Flag it so it gets swapped for the
# External Database URL from the Postgres instance's dashboard page.
if grep -qE '^DATABASE_URL=.*@dpg-[^.]*(:[0-9]+)?/' .env; then
  echo
  echo "!! DATABASE_URL is Render's INTERNAL address and will NOT resolve locally."
  echo "   Replace it in .env with the External Database URL:"
  echo "   Render dashboard -> your Postgres instance -> Connections -> External Database URL"
  echo "   (append ?sslmode=require)"
fi

cat <<'NOTE'

!! MYOB_REDIRECT_URI must exactly match a URI registered on the MYOB app.
   Post-March-2025 keys require https://, so http://localhost:3000/auth/callback
   will be rejected. For OAuth locally, run a tunnel and register that URL:
       cloudflared tunnel --url http://localhost:3000
   then set APP_BASE_URL + MYOB_REDIRECT_URI to the tunnel hostname.
   Read-only browsing of already-synced Postgres data works without this.

NOTE

echo "==> npm install"
npm install

echo "==> Starting dev server on http://localhost:3000"
echo "    /          connection console"
echo "    /dashboard inventory dashboard (needs DASHBOARD_ACCESS_KEY)"
npm run dev
