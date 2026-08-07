# Production deploy: admin.potapoff.fun

This guide deploys `admin-site` as a separate service behind host Nginx.

## 1. DNS

Create an A/AAAA record for `admin.potapoff.fun` pointing to the production server.

## 2. Prepare configuration

```bash
cd /opt/claude-project/admin-site
cp .env.example .env
cp sources.example.json sources.json
cp logs.example.json logs.json
```

Generate credentials locally on the server:

```bash
openssl rand -hex 48
# use as ADMIN_SESSION_SECRET

docker compose run --rm admin python scripts/hash_password.py
# use output as ADMIN_PASSWORD_HASH
```

Never commit `.env`, `sources.json` containing credentials, or generated state DBs.

## 3. Database access

Use dedicated read-only users for every PostgreSQL source. Do not reuse application owner credentials.

Example policy per database:

```sql
CREATE ROLE admin_reader LOGIN PASSWORD 'GENERATE_A_LONG_RANDOM_PASSWORD';
GRANT CONNECT ON DATABASE your_database TO admin_reader;
GRANT USAGE ON SCHEMA public TO admin_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO admin_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO admin_reader;
ALTER ROLE admin_reader SET default_transaction_read_only = on;
```

Adjust `sources.json` to the actual Docker service names and read-only usernames.

## 4. Shared Docker network

```bash
docker network inspect potapoff-shared >/dev/null 2>&1 || docker network create potapoff-shared
```

Attach the product PostgreSQL services that the admin must read to `potapoff-shared`. Do not publish database ports to the public internet.

## 5. Start Control Center

```bash
docker compose config
docker compose build --pull
docker compose up -d

docker compose ps
curl --fail http://127.0.0.1:18080/api/health
```

The admin container is bound only to `127.0.0.1:18080`; it is not directly reachable from the public network.

## 6. TLS / Nginx

Install the supplied config:

```bash
sudo cp deploy/nginx-admin.conf /etc/nginx/sites-available/admin.potapoff.fun
sudo ln -s /etc/nginx/sites-available/admin.potapoff.fun /etc/nginx/sites-enabled/admin.potapoff.fun
```

Obtain a certificate (example with Certbot):

```bash
sudo certbot certonly --nginx -d admin.potapoff.fun
sudo nginx -t
sudo systemctl reload nginx
```

If Certbot edits Nginx automatically, verify the final proxy target remains `127.0.0.1:18080`.

## 7. Firewall

Public inbound ports should normally be limited to 80/443 (and SSH from trusted networks). Do not expose 18080, PostgreSQL, Redis, or RabbitMQ publicly.

Optionally set `ADMIN_ALLOWED_NETWORKS` to your office/VPN public CIDRs before first login.

## 8. Verification

```bash
curl -I https://admin.potapoff.fun/
curl --fail https://admin.potapoff.fun/api/health

docker compose logs --tail=100 admin
```

Then verify in a browser:

- login succeeds;
- session cookie is Secure/HttpOnly/SameSite=Strict;
- product DB tables are readable;
- write operations against product DBs are unavailable;
- audit log records login/logout/export events;
- source failures do not expose credentials or DSNs.

## 9. Rollback

```bash
git checkout <previous-good-commit>
docker compose build
docker compose up -d
```

Keep `admin-state` volume unless intentionally resetting audit/flags/alerts.
