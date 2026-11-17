# Deploying Ketamine.cc to ketaminecc.website (GoDaddy DNS)

GoDaddy registers the domain and hosts DNS. It does **not** run this Node app on its
shared hosting. The site must live on a small VPS that stays online.

Minimum VPS: 1 vCPU, 1 GB RAM, Ubuntu 24.04, public IPv4. Any provider works
(Hetzner, DigitalOcean, Vultr, Linode). Do not use Cloudflare proxying.

---

## 1. GoDaddy DNS

1. Sign in → **My Products → Domains → ketaminecc.website → DNS**.
2. Delete GoDaddy's parked-page records:
   - the `A` record for `@` pointing at a GoDaddy parking IP,
   - any **Forwarding** entry for `@` or `www`.
3. Add:

   | Type  | Name | Value        | TTL  |
   |-------|------|--------------|------|
   | A     | @    | `<VPS IPv4>` | 600  |
   | CNAME | www  | @            | 600  |

4. Leave the nameservers on GoDaddy's defaults. No proxy/CDN toggles.
5. Propagation usually takes 5–30 minutes. Check:

   ```powershell
   nslookup ketaminecc.website 8.8.8.8
   ```

---

## 2. Prepare the VPS

SSH in as root, then:

```bash
apt update && apt -y upgrade
apt -y install caddy rsync ufw curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt -y install nodejs
node -v    # v24.x

useradd --system --create-home --home-dir /srv/ketamine --shell /usr/sbin/nologin ketamine
mkdir -p /srv/ketamine/server/data
chown -R ketamine:ketamine /srv/ketamine

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Also open ports **80** and **443** in the VPS provider's firewall panel.

---

## 3. Upload the project

Run from the project folder on this PC:

```powershell
scp -r index.html login.html dashboard.html account.html checkout.html checkout-success.html admin.html assets deploy root@<VPS_IP>:/srv/ketamine/
scp -r server/src server/package.json server/package-lock.json server/.env.example root@<VPS_IP>:/srv/ketamine/server/
```

Never upload `node_modules`, `server/data`, or your local `server/.env`.

On the VPS, create `/srv/ketamine/server/.env`:

```ini
NODE_ENV=production
PUBLIC_BASE_URL=https://ketaminecc.website
HOST=127.0.0.1
PORT=3000
DEMO_MODE=false

SESSION_SECRET=<64 hex chars>
ENC_KEY=<64 hex chars>
ADMIN_SECRET=<your admin secret>
BOT_SHARED_SECRET=<same value the bot uses>

STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

DISCORD_PURCHASE_WEBHOOK_URL=
SUPPORT_EMAIL=support@ketaminecc.site
```

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Back up `ENC_KEY` and `server/data/store.db`; losing the key makes existing licenses unrecoverable.

---

## 4. Install and start

```bash
cd /srv/ketamine/server
npm ci --omit=dev
chown -R ketamine:ketamine /srv/ketamine

cp /srv/ketamine/deploy/ketamine.service /etc/systemd/system/ketamine.service
systemctl daemon-reload
systemctl enable --now ketamine
curl -s http://127.0.0.1:3000/api/health

cp /srv/ketamine/deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy requests the certificate once DNS resolves to the VPS. Then:

```powershell
curl.exe -I https://ketaminecc.website
```

Expected: `HTTP/2 200` (or a redirect to `/`, both fine) with a valid certificate.

---

## 5. Stripe

Stripe Dashboard → **Developers → Webhooks → Add endpoint**:

- URL: `https://ketaminecc.website/api/webhook/stripe`
- Events:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.expired`
  - `charge.refunded`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`, then:

```bash
systemctl restart ketamine
```

Try a Stripe **test-mode** purchase first; once it issues a key, switch the `.env`
to live keys and refresh the webhook secret.

---

## 6. Discord bot

In `C:\Users\angel\OneDrive\Documents\ketaminebot\.env`:

```ini
SITE_API_URL=https://ketaminecc.website
BOT_SHARED_SECRET=<same as the website>
OWNER_ID=<your Discord user ID>
```

Restart the bot and run `/verify` as the guild owner.

---

## Updating the site later

```powershell
scp -r index.html assets root@<VPS_IP>:/srv/ketamine/
scp -r server/src root@<VPS_IP>:/srv/ketamine/server/
```

```bash
systemctl restart ketamine
```

The database lives in `/srv/ketamine/server/data/` and survives uploads.
