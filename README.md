# Ketamine.cc — storefront + licensing platform

A complete, self-hosted storefront: marketing site, Stripe checkout, account dashboard,
license issuance, admin console, encrypted Discord purchase log, and an owner-only reveal
command wired into the existing `ketaminebot` Discord bot.

No Cloudflare, no external auth provider, no card data on this server.

```
fwaf/
├─ index.html                 storefront
├─ login.html                 sign in / create account
├─ checkout.html              order review + payment
├─ checkout-success.html      license delivery
├─ dashboard.html             license keys (account)
├─ account.html               orders + password
├─ admin.html                 owner console
├─ assets/                    styles, client scripts, santa hat decal, favicon
└─ server/
   ├─ src/                    Express API, SQLite, Stripe, encryption, admin
   ├─ data/store.db           database (created on first boot)
   └─ .env                    secrets and configuration
```

The other half of the integration lives in `C:\Users\angel\OneDrive\Documents\ketaminebot`
(`/verify` command + website bridge settings).

---

## 1. Run it locally

```powershell
cd server
npm install          # already installed
npm start
```

- Store: http://localhost:3000
- Admin: http://localhost:3000/admin
- Admin secret: `ADMIN_SECRET` in `server/.env`

`DEMO_MODE=true` is set for local development. Checkout issues a real key without charging
a card. **Set `DEMO_MODE=false` in production.**

The database and all generated keys live in `server/data/store.db`.

---

## 2. How the purchase flow works

1. Visitor clicks **Purchase** → `checkout.html`.
2. Not signed in yet → forced to `login.html?next=/checkout?product=…`.
3. Signed in → order is created as `pending`, Stripe Checkout opens.
4. Stripe calls `POST /api/webhook/stripe` (signature verified).
5. Server issues `KET-XXXXX-XXXXX-XXXXX-XXXXX`, computes the expiration date, marks the
   order paid.
6. The success page polls the order and displays the key + exact expiry.
7. Keys are listed on the independent `/dashboard.html` page and linked to the account email.
   `/account.html` holds orders and password settings only.

Orders cannot be fulfilled without the authenticated account that created them.

---

## 3. Stripe setup (live)

1. In the Stripe Dashboard, complete business activation.
2. Copy the **secret key** (`sk_live_…`) into `server/.env` as `STRIPE_SECRET_KEY`.
3. Add a webhook endpoint:
   - URL: `https://api.ketaminecc.site/api/webhook/stripe`
   - Events:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.expired`
     - `charge.refunded`
4. Copy the endpoint **signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
5. Set `DEMO_MODE=false`, `NODE_ENV=production`,
   `PUBLIC_BASE_URL=https://api.ketaminecc.site`, `PUBLIC_SITE_URL=https://ketaminecc.site`.
6. Restart/redeploy the server.

Prices are sent to Stripe dynamically from the admin-managed product records, so editing a
plan in the dashboard changes what Stripe charges on the next checkout. No Stripe product IDs
need to be maintained.

Test cards: `4242 4242 4242 4242`, any future expiry, any CVC.

---

## 4. Deploy on your own domain (no Cloudflare)

Two supported layouts:

**A. GitHub Pages static frontend + Render API (split hosting)**
Step-by-step: **`deploy/GITHUB-PAGES.md`**. Pages serves `ketaminecc.site`; Render serves
`api.ketaminecc.site`; `render.yaml` and `.github/workflows/pages.yml` are included.
A Render persistent disk (Starter plan) is required so SQLite survives deploys.

**B. One Ubuntu VPS (everything on one box)**
Step-by-step: **`deploy/SETUP.md`**. Ready-to-copy `deploy/Caddyfile` and
`deploy/ketamine.service` are included.

Minimum: one Linux VPS (1 vCPU / 1 GB is enough), your domain's DNS pointed at it.

1. **DNS** — create an `A` record for `ketaminecc.site` (and optionally `www`) pointing to
   the VPS IP. If your registrar offers proxy/CDN, leave it **DNS-only**.
2. **Install** Node.js 22+ and Caddy.
3. **Copy** this folder to `/srv/ketamine` and run `npm install --omit=dev` in `server/`.
4. **Environment** — edit `/srv/ketamine/server/.env`:
   ```ini
   NODE_ENV=production
   PUBLIC_BASE_URL=https://ketaminecc.site
   DEMO_MODE=false
   STRIPE_SECRET_KEY=sk_live_…
   STRIPE_WEBHOOK_SECRET=whsec_…
   ```
   Keep `SESSION_SECRET`, `ENC_KEY`, `BOT_SHARED_SECRET`, `ADMIN_SECRET` private.
5. **Service** — `/etc/systemd/system/ketamine.service`:
   ```ini
   [Unit]
   Description=Ketamine.cc licensing
   After=network.target

   [Service]
   WorkingDirectory=/srv/ketamine/server
   ExecStart=/usr/bin/node src/server.js
   Restart=always
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   systemctl daemon-reload && systemctl enable --now ketamine
   ```
6. **Caddy** — automatic Let's Encrypt TLS, no Cloudflare involved:
   ```caddy
   ketaminecc.site, www.ketaminecc.site {
       reverse_proxy 127.0.0.1:3000
       encode zstd gzip
       header {
           -Server
       }
   }
   ```
7. **Firewall** — allow 80/443 only. Port 3000 stays local (`HOST=127.0.0.1` is fine behind
   Caddy; the default `0.0.0.0` works too but do not expose it publicly).
8. **Stripe webhook** — point it at the live HTTPS URL above and paste the signing secret
   into `.env`, then `systemctl restart ketamine`.

Back up **both** `server/data/store.db` and `ENC_KEY`. Without the encryption key, existing
license rows cannot be decrypted.

---

## 5. Encrypted Discord purchase log

Set the webhook either in **Admin → Settings → Purchase log webhook** or via
`DISCORD_PURCHASE_WEBHOOK_URL` in `server/.env`. Use **Send test** to verify.

Every successful purchase posts an embed containing only:

- the purchase ID (plaintext, for support lookup),
- a one-time verification code,
- one or more AES-256-GCM sealed payloads.

The sealed payload includes customer email/name, product, amount, license key, expiry,
Stripe IDs, and the recording timestamp. Tampering with the ciphertext breaks decryption.

### Reveal flow

1. You copy the code from the Discord message.
2. Run `/verify code:A7F2-9K3Q` in the server.
3. The bot calls `POST /api/internal/reveal` with `BOT_SHARED_SECRET`.
4. The site decrypts the record, marks the code **used**, and returns it ephemerally.
5. A second attempt with the same code is rejected.

Owner gating: the bot accepts `/verify` from the guild owner, or from any ID listed in
`OWNER_ID` (comma-separated). Everyone else gets an ephemeral refusal.

Bot configuration (`ketaminebot/.env`):

```ini
SITE_API_URL=http://localhost:3000      # use https://ketaminecc.site in production
BOT_SHARED_SECRET=…                     # must equal server/.env
OWNER_ID=                               # optional extra owner IDs
```

Restart the bot after editing. Slash commands re-register on boot.

The admin console can also reveal a code under **Settings → Verification codes**.

---

## 6. Admin console

`/admin` — secret-key login, 8-hour session, all actions written to the audit log.

- **Overview** — 30-day revenue/orders, active licenses, expiries, pending orders, refunds.
- **Orders** — search, decrypt details, refund through Stripe, revoke keys.
- **Licenses** — generate 1–100 at once for any product, any duration (`lifetime` or days),
  and attach them to an account email. Revoke, blacklist, copy keys. Keys issued to an email
  appear for that account automatically; registering later claims them.
- **Products** — edit name, tagline, price, duration, features, badge, currency note, sort,
  visibility; create new plans. Changes are live immediately.
- **Customers** — spend, orders, active keys, last login; suspend or restore.
- **Blacklist** — email, license key, IP, or Discord ID; blocked at checkout/registration and
  in the license validation endpoint.
- **Audit log** — admin logins, refunds, key generation, revocations, setting changes.
- **Settings** — brand, support email, Discord invite, purchase webhook, test webhook, code
  reveal, Stripe/bot status.

Refunds revoke the order's license automatically. Blacklisting a user revokes their active
licenses. Every license check reflects the change immediately.

---

## 7. License validation API (for your software)

```http
GET /api/license/validate?key=KET-XXXXX-XXXXX-XXXXX-XXXXX
```

```json
{
  "valid": true,
  "status": "active",
  "product": "Monthly Pass",
  "issuedAt": 1794937500000,
  "expiresAt": 1797530400000,
  "order": "KT-261117-9F4K2",
  "preview": "KET-•••••-•••••-•••••-4T2RV"
}
```

Statuses: `active`, `expired`, `revoked`, `blacklisted`, `not_found`.
Rate-limited; no authentication required. Do not expose full keys in client-side logs.

Other endpoints used by the site:

```
POST /api/auth/register | login | logout | password
GET  /api/me
GET  /api/products
POST /api/checkout
GET  /api/orders, /api/orders/:number
GET  /api/licenses                  current account keys
POST /api/webhook/stripe
POST /api/internal/reveal          (bot only, X-Bot-Secret)
POST /api/admin/*                  (admin session)
```

---

## 8. Security notes

- Passwords: scrypt with per-user salts.
- Sessions: random 256-bit tokens, only SHA-256 hashes stored; HTTP-only, SameSite=Lax,
  Secure cookies under HTTPS.
- License keys and Discord payloads: AES-256-GCM with a server-side key.
- Stripe: raw-body signature verification before fulfillment.
- CSP, frame denial, nosniff, referrer and permissions policies.
- In-memory rate limits on auth, checkout, admin login, validation, and bot reveal.
- Origin checks on state-changing requests; explicit static-file allowlist so `/server`
  (including `.env`) is never served.
- Demo mode must be off in production or keys can be issued without payment.

### Before going live

- [ ] `DEMO_MODE=false`
- [ ] `NODE_ENV=production`, HTTPS base URL
- [ ] Stripe live keys + webhook secret
- [ ] Fresh secrets if this folder was ever shared (`SESSION_SECRET`, `ENC_KEY`,
      `BOT_SHARED_SECRET`); rotating `ENC_KEY` makes existing rows unreadable
- [ ] Change the admin secret from the setup value
- [ ] Back up `store.db` + `ENC_KEY`
- [ ] Remove `node_modules` from any copy you upload (reinstall on the server)

---

## 9. Holiday decal

`assets/santa-hat.png` is the supplied decal, used on the storefront, login, and admin screens.
It is a transparent PNG rendered at its natural aspect ratio; swap the file (same name) to change it.

---

## 10. Snowfall

`assets/app.js` draws six-armed snowflakes on a canvas with depth, sway, rotation, and
DPI scaling. It pauses when the tab is hidden, hides on reduced-motion, and is disabled on
the admin console via `data-snow="off"`.
