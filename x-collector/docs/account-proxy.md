# Individual account proxies

Open **Settings → X Collector → Аккаунты → Настроить** on the account you want to configure.

1. Select HTTP, HTTPS or SOCKS5.
2. Enter `host:port`, `user:pass@host:port` or a complete proxy URL. For IPv6, use brackets: `user:pass@[2001:db8::1]:8080`.
3. Use **TEST** to check connectivity and see the masked outgoing IP, country and latency. **Проверить и сохранить прокси** checks the connection again and saves it only for that account. A failed check preserves the previous configuration.
4. Use **Полная проверка** to verify the database, session, proxy, browser and X. A successful IP check alone does not prove that X is reachable.

Stored passwords are never returned by the account API. The collector and autopost browser use the selected account's proxy, User-Agent, timezone and language. Changing an account that is busy or has changed since the form was loaded is rejected; refresh and retry after it is released. **Убрать прокси** restores direct connections for that account.

## Updating an existing installation

Run from `x-collector`:

```powershell
npm run migrate
node scripts/setup-autopost.cjs
```

Migration `020_account_profile.sql` is additive. It preserves sessions and adds account health, identity metadata and redacted diagnostic history. Registering a replacement session clears its previous diagnostic result.

For a read-only CLI check:

```powershell
node scripts/account-check.cjs ACCOUNT_NAME --json
```

The check does not post, like, follow or repost.

## Saved list sources

Register lists once using IDs or full X list URLs:

```powershell
node --import tsx scripts/collect-lists.ts 1878727153048777016 953048248406519809 1945268064792068152
```

The IDs and schedule are stored in `xc_auto_sources`. Enabled lists are collected every 15 minutes through collector accounts, with duplicate active tasks prevented. The autopost worker also starts the list scheduler for saved sources:

```powershell
node scripts/autopost-worker.cjs
```

List collection status is shown under **Автопостинг**. Collection still requires a valid session and connectivity to X. Without fresh relevant source posts, the agent skips the cycle instead of inventing events.
