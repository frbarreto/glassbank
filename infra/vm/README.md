# Glass Bank on a Compute Engine VM (the documented alternative)

Block: `infra`. Cloud Run is the chosen path (D-2, `docs/DEPLOYMENT.md`). This directory keeps the same image runnable on a VM without a redesign (A-20, A-30). D-7 keeps the existing `laf-ingestor` VM terminated.

| File | What it is |
|---|---|
| `docker-compose.yml` | Caddy (ports 80/443, persistent `/data`) in front of the app container on a private compose network |
| `Caddyfile` | Option A: a `nip.io` hostname derived from a static IP, ordinary Let's Encrypt HTTP-01 certificate; the default mount |
| `Caddyfile.ip-cert` | Option B: a Let's Encrypt certificate for the bare IP (`shortlived` ACME profile); selected with `CADDYFILE=./Caddyfile.ip-cert` |

Trade-off (D-2): the VM wins only on durable state (SQLite on a real disk) and unbounded SSE length; Cloud Run wins on URL and TLS, operations, deploy and rollback, and blast radius.

## 1. VM and network (gcloud, from the Mac)

Never run. Several lines change the existing VM's networking; read before running.

```bash
export PROJECT_ID=lake-fraude ZONE=us-central1-a REGION=us-central1 VM=laf-ingestor

# e2-standard-4 (~US$98/month) -> e2-small (~US$12/month); only possible while TERMINATED.
gcloud compute instances set-machine-type "$VM" --zone="$ZONE" --machine-type=e2-small

# Static external IP: nip.io encodes it in the hostname, an IP certificate is issued for it literally.
gcloud compute addresses create mcp-bank-ip --region="$REGION"
IP=$(gcloud compute addresses describe mcp-bank-ip --region="$REGION" --format='value(address)')
gcloud compute instances delete-access-config "$VM" --zone="$ZONE" --access-config-name="external-nat"
gcloud compute instances add-access-config    "$VM" --zone="$ZONE" --access-config-name="external-nat" --address="$IP"

# Tag `laf-ingestor` has a priority-1000 deny-all ingress rule; a lower number wins. Port 80 serves HTTP-01 and the redirect.
gcloud compute firewall-rules create laf-ingestor-allow-web \
  --network=default --direction=INGRESS --action=ALLOW \
  --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=laf-ingestor --priority=800

gcloud compute instances start "$VM" --zone="$ZONE"
gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap
```

## 2. Host (on the VM, Ubuntu 24.04)

```bash
# Docker Engine and the compose plugin from Docker's apt repository.
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER" && newgrp docker
```

## 3. Image

Pull the one Cloud Build produced (the VM service account needs `roles/artifactregistry.reader`):

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
export MCP_BANK_IMAGE=us-central1-docker.pkg.dev/lake-fraude/lake-fraude/mcp-bank:<tag>
docker pull "$MCP_BANK_IMAGE"
```

Or build from a checkout; with `MCP_BANK_IMAGE` unset, compose builds `infra/Dockerfile`:

```bash
git clone <this repository> glass-bank && cd glass-bank/infra/vm
```

## 4. Run

Secrets go in a root-owned `.env` beside `docker-compose.yml` (`chmod 600`) or in the shell that runs compose, never in the image (CLAUDE.md invariant 12). `PUBLIC_BASE_URL` is the exact `https://` URL users type, never the `http://` form Caddy redirects from: the PRM `resource`, the issuer and the token `aud` derive from it (invariant 4, A-36). Every other app knob in `docker-compose.yml` carries its `.env.example` default and is overridden the same way.

Option A - nip.io hostname (recommended):

```bash
cd glass-bank/infra/vm
export SITE_ADDRESS="$(echo "$IP" | tr '.' '-').nip.io"   # 34.30.1.2 -> 34-30-1-2.nip.io
export ACME_EMAIL=you@example.com
export PUBLIC_BASE_URL="https://$SITE_ADDRESS" PUBLIC_HOSTS="$SITE_ADDRESS"
export OAUTH_SIGNING_KEY="$(openssl rand -base64 48)" XRAY_ADMIN_TOKEN="$(openssl rand -hex 24)"
docker compose up -d
```

Option B - Let's Encrypt IP-address certificate:

```bash
export PUBLIC_IP="$IP" CADDYFILE=./Caddyfile.ip-cert
export ACME_EMAIL=you@example.com
export PUBLIC_BASE_URL="https://$PUBLIC_IP" PUBLIC_HOSTS="$PUBLIC_IP"
export OAUTH_SIGNING_KEY="$(openssl rand -base64 48)" XRAY_ADMIN_TOKEN="$(openssl rand -hex 24)"
docker compose up -d
```

## 5. Verify

```bash
docker compose ps                       # both containers up, mcp-bank healthy
docker compose logs -f caddy            # watch the certificate being issued
SMOKE_HOSTS="$PUBLIC_HOSTS" infra/smoke.sh "$PUBLIC_BASE_URL"   # from the Mac
```

`smoke.sh` treats every `https://` target as Cloud Run: without `SMOKE_HOSTS` check 4 also queries the `run.app` hostname, and checks 6 and 7 always fail here because they describe the Cloud Run service `mcp-bank` (there is no switch to skip them). Expect those two failures and read the rest.

## 6. Verified / not verified

Verified on the Mac (2026-09-09; Docker 27.4.0, compose v2.31.0, `caddy:2.11-alpine` = Caddy v2.11.4):

- `docker compose config` mounts `Caddyfile` by default and `Caddyfile.ip-cert` with `CADDYFILE=./Caddyfile.ip-cert`.
- Both Caddyfiles pass `caddy validate --adapter caddyfile` with no warnings.
- `docker compose config` refuses to run when `PUBLIC_BASE_URL`, `PUBLIC_HOSTS` or `OAUTH_SIGNING_KEY` is unset.
- Every app env name in `docker-compose.yml` is read by `src/config/index.ts` and listed in `.env.example`; `infra/local/docker-compose.yml` builds the same `infra/Dockerfile`.

Not verified (needs cloud resources that were never created):

- No gcloud command in section 1 has run: `laf-ingestor` is TERMINATED, there is no `mcp-bank-ip` address and no `laf-ingestor-allow-web` rule.
- No certificate has been issued by either option. Option B depends on Let's Encrypt IP certificates (`shortlived` profile, ~6-day lifetime) and on Caddy >= 2.11.3 driving them, neither confirmed here; a broken renewal breaks the demo within a week.
- The two containers have never been started together: the Caddy-to-app hop, `flush_interval -1` for SSE and the health-check ordering are unproven.
- `nip.io` is a third-party service; if it stops resolving, option A stops working.
