# Self-hosted Nitter for Twitter/X research

## Important

Nitter instances are frequently rate-limited or broken by Twitter/X changes. For research usage, run it behind a private domain and avoid exposing it as a public instance.

## Files

- `docker-compose.yml` - Nitter + Redis.
- `nitter.conf` - base production config.

## VPS setup

Install Docker and Compose plugin on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Copy this folder to the VPS:

```bash
scp -r infra/nitter root@YOUR_VPS_IP:/opt/nitter
```

On the VPS:

```bash
cd /opt/nitter
openssl rand -hex 32
```

Put the generated value into `nitter.conf` as `hmacKey` and replace `hostname` / `replaceTwitter` with your domain.

Start:

```bash
docker compose up -d
```

Check:

```bash
docker compose ps
curl -I http://127.0.0.1:8080
```

## Nginx reverse proxy

Example for `nitter.yourdomain.com`:

```nginx
server {
    listen 80;
    server_name nitter.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable HTTPS with Certbot:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d nitter.yourdomain.com
```

## Updating

```bash
cd /opt/nitter
docker compose pull
docker compose up -d
```

## Logs

```bash
cd /opt/nitter
docker compose logs -f nitter
```
