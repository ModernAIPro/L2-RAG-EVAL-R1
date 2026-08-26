#!/usr/bin/env bash
# Rotate CHAT_PASSWORD everywhere, redeploy, and prove it worked.
#   npm run rotate
# Override the site checked at the end with:  SITE=https://example.com npm run rotate
set -euo pipefail

cd "$(dirname "$0")/.."
SITE="${SITE:-https://starkfarms.in}"

# Generate it ourselves and print it at the end. Vercel stores production and
# preview vars write-only, so a value typed at `vercel env add`'s prompt can
# never be read back — losing it means another rotation.
PW=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")

echo "Rotating CHAT_PASSWORD…"
for ENV in production preview development; do
  vercel env rm CHAT_PASSWORD "$ENV" --yes >/dev/null 2>&1 || true
  printf '%s' "$PW" | vercel env add CHAT_PASSWORD "$ENV" >/dev/null 2>&1
  echo "  ✓ $ENV"
done

# Keep local `npm run dev` in step with the deployed gate.
if [ -f ../.env ]; then
  if grep -q '^CHAT_PASSWORD=' ../.env; then
    sed -i '' "s|^CHAT_PASSWORD=.*|CHAT_PASSWORD=$PW|" ../.env
  else
    printf '\nCHAT_PASSWORD=%s\n' "$PW" >>../.env
  fi
  echo "  ✓ ../.env"
fi

# Env vars only reach a deployment built after they were set.
echo "Deploying…"
vercel --prod --yes >/dev/null 2>&1

# Brace the name: a bare $SITE followed by a multibyte character gets parsed as
# part of the variable name, which `set -u` then rejects as unbound.
echo "Verifying ${SITE}"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/chat" \
  -H 'Content-Type: application/json' \
  -H "x-chat-password: $PW" \
  -d '{"messages":[{"role":"user","content":"ping"}]}')

if [ "$code" = "200" ]; then
  echo
  echo "Done. NEW PASSWORD: $PW"
else
  echo
  echo "Rotated, but $SITE answered $code instead of 200 — check 'vercel ls'."
  echo "NEW PASSWORD: $PW"
  exit 1
fi
