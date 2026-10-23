# Production runbook

Bilhanah runs on one server with Docker Compose (`infra/compose.prod.yml`):

| Service | Role |
| --- | --- |
| `caddy` | HTTPS for `bilhanah.com`, `*.bilhanah.com` (wildcard certificate), serves the website and dashboard, proxies the API |
| `api` ×2 | NestJS HTTP API (`dist/main.js`) |
| `worker` | Background jobs: email delivery with retries, hourly cleanup (`dist/worker.js`) |
| `postgres`, `redis` | Data; Redis persists queued jobs (AOF) |
| `migrate` | One-off `prisma migrate deploy`, run by `deploy.sh` |

Hosts: `bilhanah.com` (website, `www` redirects), `app.` (dashboard), `api.` (API and `/media`), every other subdomain is a restaurant menu.

## 1. Provision the server (once)

1. A VPS with 2 vCPU / 4 GB RAM or more (e.g. Hetzner CX32), Ubuntu LTS. Add your SSH key; disable password login.
2. Firewall: allow 22, 80 and 443 (TCP) and 443/UDP only.
   ```bash
   ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw enable
   apt install -y unattended-upgrades rclone
   ```
3. Install Docker Engine and the Compose plugin (docs.docker.com/engine/install/ubuntu).
4. Clone the repository to `/opt/bilhanah`.

## 2. DNS (Cloudflare)

Create these records pointing at the server's IP, **DNS only (grey cloud)**: Caddy terminates TLS itself and must see real client IPs for rate limiting.

| Type | Name | Value |
| --- | --- | --- |
| A | `bilhanah.com` | server IP |
| A | `*.bilhanah.com` | server IP |
| A | `www` | server IP |

Create an API token with **Zone → DNS → Edit** for the zone. Caddy uses it to prove control of the domain (DNS-01) for the wildcard certificate; HTTP challenges cannot issue wildcards.

## 3. Configure

```bash
cp infra/.env.prod.example infra/.env.prod && chmod 600 infra/.env.prod
openssl rand -hex 32   # JWT_ACCESS_SECRET
openssl rand -hex 24   # POSTGRES_PASSWORD (hex keeps it URL-safe)
```

Fill in every value. Secrets are generated fresh for production, never copied from development. `DATA_ENCRYPTION_KEY` must never change after the first administrator is created. Email needs a transactional provider (Resend, Postmark or Amazon SES) with SPF/DKIM set up for the sending domain.

## 4. Deploy (first time and every release)

```bash
cd /opt/bilhanah && git pull
bash infra/scripts/deploy.sh
```

The script builds the images, starts Postgres and Redis, applies migrations, then replaces the API, worker and edge. Caddy retries requests for up to 10 s while API containers restart, so deploys cause at most a short delay.

**Migrations must stay backward compatible for one release** (add columns before using them; drop them a release later), because the old API keeps serving while the new one starts.

Create the first administrator (it prints an authenticator key once; administrators sign in at `https://app.bilhanah.com/admin/login` with their password and a 6-digit code):

```bash
docker compose -f infra/compose.prod.yml --env-file infra/.env.prod exec api node dist/commands/create-admin.cli.js --email you@bilhanah.com --name "Your Name"
```

Then, in the admin console, enter the InstaPay, Vodafone Cash and bank details owners pay to (Settings → Payment details). A lost authenticator: `exec api node dist/commands/reset-admin-mfa.cli.js --email ...`.

## 5. Rollback

```bash
git checkout <previous-tag> && bash infra/scripts/deploy.sh
```

Database migrations are not rolled back automatically; that is why they must be backward compatible.

## 6. Backups

Nightly with cron (`crontab -e` as root):

```cron
0 3 * * * BACKUP_REMOTE=r2:bilhanah-backups /opt/bilhanah/infra/scripts/backup.sh >> /var/log/bilhanah-backup.log 2>&1
```

Dumps are kept 30 days in `/var/backups/bilhanah`.

Payment receipts are stored under the `private/` prefix and only streamed by the API. With R2 behind a public custom domain, add a Cloudflare WAF rule that blocks `/private/*` on the media hostname (or keep `STORAGE_DRIVER=local`, where the API never serves that path). Configure the `r2` remote with `rclone config` (Cloudflare R2, a bucket separate from images) so copies survive the loss of the server. With `STORAGE_DRIVER=local`, also back up the `bilhanah-prod_media` volume (or use R2 for images).

**Test a restore every month** on a staging server or a scratch database:

```bash
bash infra/scripts/restore.sh /var/backups/bilhanah/bilhanah-<timestamp>.dump
```

## 7. Operations

| Task | Command (prefix: `docker compose -f infra/compose.prod.yml --env-file infra/.env.prod`) |
| --- | --- |
| Status | `ps` |
| Logs | `logs -f --tail=200 api worker caddy` |
| Database shell | `exec postgres psql -U bilhanah bilhanah` |
| Restart a service | `restart worker` |

Health: `https://api.bilhanah.com/health/ready` checks PostgreSQL and Redis. Point an uptime monitor (Better Stack, Uptime Kuma) at it and at one restaurant page. Logs are JSON and rotated (5 × 20 MB per container).

## Test the production stack locally

The same files run on a laptop with Caddy's internal certificates:

```bash
cat > infra/.env.prod <<'ENV'
ROOT_DOMAIN=bilhanah.localhost
ACME_EMAIL=dev@bilhanah.localhost
TLS_MODE=internal
HTTP_PORT=8080
HTTPS_PORT=8443
PUBLIC_PORT_SUFFIX=:8443
POSTGRES_USER=bilhanah
POSTGRES_PASSWORD=localprodtest
POSTGRES_DB=bilhanah
CORS_ORIGINS=https://app.bilhanah.localhost:8443
DASHBOARD_URL=https://app.bilhanah.localhost:8443
RESTAURANT_URL_TEMPLATE=https://{subdomain}.bilhanah.localhost:8443
JWT_ACCESS_SECRET=local-production-test-secret-0123456789abcdef
STORAGE_DRIVER=local
MEDIA_PUBLIC_URL=https://api.bilhanah.localhost:8443/media
SMTP_HOST=host.docker.internal
SMTP_PORT=1025
MAIL_FROM=Bilhanah <no-reply@bilhanah.localhost>
ENV
bash infra/scripts/deploy.sh
```

Then open `https://bilhanah.localhost:8443` (accept the local certificate). Stop it with `docker compose -f infra/compose.prod.yml --env-file infra/.env.prod down`.
