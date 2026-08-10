# Production deploy: admin.potapoff.fun

This guide deploys `admin-site` and the isolated POTAPoff Intelligence worker behind host Nginx.

## 1. DNS

Create an A/AAAA record for `admin.potapoff.fun` pointing to the production server.

## 2. Prepare configuration

```bash
cd /opt/claude-project/admin-site
cp .env.example .env
cp .env.intelligence.example .env.intelligence
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

Never commit `.env`, `.env.intelligence`, `sources.json` containing credentials, or generated state DBs.

**Secret boundary:** `.env` belongs to the admin container. `.env.intelligence` belongs only to `intelligence-worker`. Never copy the worker PostgreSQL DSN into `.env`, and never pass the complete admin `.env` to the worker.

## 3. Database access

Use dedicated read-only users for every PostgreSQL source. Do not reuse application owner credentials.

Example policy per product database:

```sql
CREATE ROLE admin_reader LOGIN PASSWORD 'GENERATE_A_LONG_RANDOM_PASSWORD';
GRANT CONNECT ON DATABASE your_database TO admin_reader;
GRANT USAGE ON SCHEMA public TO admin_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO admin_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO admin_reader;
ALTER ROLE admin_reader SET default_transaction_read_only = on;
```

Adjust `sources.json` to the actual Docker service names and read-only usernames.

## 4. Intelligence persistence

### SQLite: single-host default

Keep these defaults:

`admin-site/.env`:

```text
ADMIN_INTELLIGENCE_BACKEND=sqlite
ADMIN_INTELLIGENCE_POSTGRES_DSN=
```

`admin-site/.env.intelligence`:

```text
POTAPOFF_INTELLIGENCE_BACKEND=sqlite
POTAPOFF_INTELLIGENCE_POSTGRES_DSN=
```

The worker writes the `intelligence-state` volume. Admin mounts the same volume read-only.

### PostgreSQL: multi-worker deployment

Create two different roles:

1. worker role: owns/updates intelligence jobs and documents;
2. admin telemetry role: `SELECT` only.

Example read-only role after the intelligence tables exist:

```sql
CREATE ROLE intelligence_reader LOGIN PASSWORD 'GENERATE_ANOTHER_LONG_RANDOM_PASSWORD';
GRANT CONNECT ON DATABASE intelligence TO intelligence_reader;
GRANT USAGE ON SCHEMA public TO intelligence_reader;
GRANT SELECT ON intelligence_documents, intelligence_jobs TO intelligence_reader;
ALTER ROLE intelligence_reader SET default_transaction_read_only = on;
```

Configure the worker **only** in `.env.intelligence`:

```text
POTAPOFF_INTELLIGENCE_BACKEND=postgres
POTAPOFF_INTELLIGENCE_POSTGRES_DSN=postgresql://WORKER_ROLE:WORKER_PASSWORD@DB_HOST/intelligence
```

Configure the admin **only** in `.env`:

```text
ADMIN_INTELLIGENCE_BACKEND=postgres
ADMIN_INTELLIGENCE_POSTGRES_DSN=postgresql://intelligence_reader:READONLY_PASSWORD@DB_HOST/intelligence
```

Initialize the PostgreSQL intelligence schema before normal worker operation:

```bash
docker compose run --rm intelligence-worker python -m intelligence init-db
```

The command uses the worker backend/DSN from `.env.intelligence`. It is idempotent and does not print the DSN.

## 5. Shared Docker network

```bash
docker network inspect potapoff-shared >/dev/null 2>&1 || docker network create potapoff-shared
```

Attach the PostgreSQL services that admin/worker must reach to `potapoff-shared`. Do not publish database ports to the public internet.

## 6. Validate and start

```bash
docker compose config
docker compose build --pull

# PostgreSQL backend only: initialize schema before the worker is expected healthy.
docker compose run --rm intelligence-worker python -m intelligence init-db

docker compose up -d

docker compose ps
curl --fail http://127.0.0.1:18080/api/health
```

Verify worker durable runtime separately:

```bash
docker compose exec intelligence-worker python -m intelligence runtime-health
```

Expected output:

```json
{"healthy": true}
```

The admin container is bound only to `127.0.0.1:18080`; the intelligence worker exposes no public port.

## 7. TLS / Nginx

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

## 8. Firewall

Public inbound ports should normally be limited to 80/443 (and SSH from trusted networks). Do not expose 18080, PostgreSQL, Redis, RabbitMQ, or the intelligence worker publicly.

Optionally set `ADMIN_ALLOWED_NETWORKS` to your office/VPN public CIDRs before first login.

## 9. Verification

```bash
curl -I https://admin.potapoff.fun/
curl --fail https://admin.potapoff.fun/api/health

docker compose logs --tail=100 admin
docker compose logs --tail=100 intelligence-worker
docker compose exec intelligence-worker python -m intelligence runtime-health
```

Then verify in a browser:

- login succeeds;
- session cookie is Secure/HttpOnly/SameSite=Strict;
- product DB tables are readable;
- write operations against product DBs are unavailable;
- `/api/intelligence/status` is available after login;
- intelligence telemetry does not expose raw evidence, query text, document URLs/metrics or provider error text;
- PostgreSQL admin telemetry role cannot INSERT/UPDATE/DELETE;
- audit log records login/logout/export events;
- source failures do not expose credentials or DSNs.

## 10. Rollback

```bash
git checkout <previous-good-commit>
docker compose build
docker compose up -d
```

Keep `admin-state` and `intelligence-state` volumes unless intentionally resetting durable state.
