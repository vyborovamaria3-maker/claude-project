# Social + AI runtime repair

This overlay fixes the production X/Twitter runtime without touching GMGN or secrets:

- installs Debian Chromium in `frontend` runtime;
- mounts `solana-launcher/data/x-auth` read-only at `/app/data/x-auth`;
- tells Playwright to use `/usr/bin/chromium`;
- adds Docker-safe Chromium launch flags;
- includes `enable-live-social-ai.ps1`, which enables Tooken as primary AI and Qwen as fallback only when an existing `TOOKEN_API_KEY` is already present in `memecoin-intelligence/.env`.

After copying the `solana-launcher` files over the project:

```powershell
cd C:\Users\Рафаил\claude-project\solana-launcher
docker compose build frontend
docker compose up -d --force-recreate frontend nginx
```

Then verify X runtime:

```powershell
docker compose exec -T frontend sh -lc 'test -f /app/data/x-auth/storage-state.json && echo X_AUTH=SET || echo X_AUTH=MISSING; command -v chromium >/dev/null 2>&1 && echo CHROMIUM=SET || echo CHROMIUM=MISSING'
```

Enable/check AI:

```powershell
powershell -ExecutionPolicy Bypass -File .\enable-live-social-ai.ps1
```
