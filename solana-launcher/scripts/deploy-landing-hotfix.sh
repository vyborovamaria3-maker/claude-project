#!/usr/bin/env bash
set -Eeuo pipefail

NEW_TAG="${1:?Usage: deploy-landing-hotfix.sh <frontend-tag>}"
REPO_DIR="/var/www/claude-project"
APP_DIR="$REPO_DIR/solana-launcher"
DEPLOY_DIR="/opt/potapoff-deploy"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
IMAGE="ghcr.io/vyborovamaria3-maker/claude-project/frontend:$NEW_TAG"
LOCK_FILE="$DEPLOY_DIR/.landing-deploy.lock"
LANDING_MARKER='Запускайте токены, анализируйте кошельки'

exec 9>"$LOCK_FILE"
flock -w 1800 9

cleanup_repo() {
  cd "$REPO_DIR" 2>/dev/null || return 0
  git reset --hard origin/main >/dev/null 2>&1 || true
  git clean -fd >/dev/null 2>&1 || true
}
trap cleanup_repo EXIT

cd "$REPO_DIR"
git fetch origin main
git reset --hard origin/main
git clean -fd

test -s solana-launcher/app/page.tsx
test -s solana-launcher/app/dashboard/page.tsx
test -s solana-launcher/components/PublicLandingPage.tsx
test -s solana-launcher/components/landing/landingContent.ts
grep -q 'PublicLandingPage' solana-launcher/app/page.tsx
grep -q 'LANDING_CSS' solana-launcher/components/PublicLandingPage.tsx
grep -q 'LANDING_BODY' solana-launcher/components/PublicLandingPage.tsx
grep -q 'pathname === "/"' solana-launcher/components/AppShell.tsx
grep -q 'window.location.href = "/dashboard"' solana-launcher/components/PasswordLoginForm.tsx
grep -Fq "$LANDING_MARKER" solana-launcher/components/landing/landingContent.ts
git diff --check

cd "$DEPLOY_DIR"
test -r .env.server
test -r "$COMPOSE_FILE"
COMPOSE=(docker compose --env-file .env.server -f "$COMPOSE_FILE")

PREVIOUS_CONTAINER="$("${COMPOSE[@]}" ps -q frontend)"
test -n "$PREVIOUS_CONTAINER"
PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$PREVIOUS_CONTAINER")"
PREVIOUS_TAG="${PREVIOUS_IMAGE##*:}"
test -n "$PREVIOUS_TAG"

rollback() {
  code=$?
  trap - ERR
  echo "LANDING_DEPLOY_FAILED rollback_to=$PREVIOUS_TAG" >&2
  export IMAGE_TAG="$PREVIOUS_TAG"
  "${COMPOSE[@]}" up -d --no-deps --force-recreate frontend || true
  "${COMPOSE[@]}" restart nginx || true
  exit "$code"
}
trap rollback ERR

cd "$APP_DIR"
docker build \
  -f Dockerfile.frontend.prod \
  --build-arg NEXT_PUBLIC_APP_URL=https://potapoff.fun \
  --build-arg NEXT_PUBLIC_FRONTEND_URL=https://potapoff.fun \
  --build-arg NEXT_PUBLIC_BACKEND_URL=https://potapoff.fun/fastapi \
  --build-arg NEXT_PUBLIC_TELEGRAM_BOT_URL=https://t.me/Soft777bot \
  --build-arg NEXT_PUBLIC_BUILD_SHA="$NEW_TAG" \
  -t "$IMAGE" .

cd "$DEPLOY_DIR"
export IMAGE_TAG="$NEW_TAG"
"${COMPOSE[@]}" up -d --no-deps --force-recreate frontend
"${COMPOSE[@]}" restart nginx

healthy=0
for attempt in $(seq 1 45); do
  cid="$("${COMPOSE[@]}" ps -q frontend)"
  state="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || true)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || true)"

  if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
    if curl -fsS http://127.0.0.1/ >/tmp/potapoff-landing.html \
      && grep -Fq "$LANDING_MARKER" /tmp/potapoff-landing.html \
      && curl -fsS http://127.0.0.1/dashboard >/dev/null \
      && curl -fsS http://127.0.0.1/miniapp >/dev/null \
      && curl -fsS http://127.0.0.1/fastapi/health >/dev/null \
      && curl -fsS http://127.0.0.1/api/build-info | grep -Fq "\"buildSha\":\"$NEW_TAG\""; then
      healthy=1
      break
    fi
  fi

  sleep 4
done

if [[ "$healthy" -ne 1 ]]; then
  echo "New frontend failed verification" >&2
  "${COMPOSE[@]}" ps frontend nginx || true
  "${COMPOSE[@]}" logs --tail 120 frontend nginx || true
  false
fi

printf '%s\n' "$NEW_TAG" > "$DEPLOY_DIR/.frontend-hotfix-tag"
trap - ERR

echo "LANDING_DEPLOY_OK tag=$NEW_TAG previous=$PREVIOUS_TAG"
