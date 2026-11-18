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

`DEMO_MODE=true` issues a real key without charging a card and is for local development only.
**Set `DEMO_MODE=false` in production.**

The database and all generated keys live in `server/data/store.db`.

---

## 2. How the purchase flow works

1. Visitor clicks **Purchase** → `checkout.html`.
2. Not signed in yet → forced to `login.html?next=/checkout?product=…`.
3. Signed in → order is created as `pending`, Stripe Checkout opens. With manual payments
   enabled the order is created as `awaiting_payment` and the buyer gets payment instructions
   instead (see §4).
4. Stripe calls `POST /api/webhook/stripe` (signature verified).
5. Server issues `KET-XXXXX-XXXXX-XXXXX-XXXXX`, computes the expiration date, marks the
   order paid.
6. The success page polls the order and displays the key + exact expiry.
7. Keys are listed on the independent `/dashboard.html` page and linked to the account email.
   `/account.html` holds orders and password settings only.

Manual orders follow the same delivery path but become `paid` only after you press
**Confirm** in **Admin → Orders**.

Orders cannot be fulfilled without the authenticated account that created them.

---

## 3. Stripe setup (live)

1. In the Stripe Dashboard, complete business activation. Checkout Sessions are rejected until
   card payments are active (`charges_enabled: true`).
2. Add the **secret key** in either place:
   - **Admin → Settings → Stripe payments** (stored encrypted in SQLite), or
   - `server/.env` as `STRIPE_SECRET_KEY` (wins over the admin value).
   A restricted key (`rk_live_…`) works if it grants **Checkout Sessions: read/write** and
   **Refunds: write**; account read is only needed for the Settings connection test.
3. Optional webhook:
   - URL: the value shown in **Admin → Settings → Stripe payments** (`/api/webhook/stripe`),
     or `<PUBLIC_BASE_URL>/api/webhook/stripe`
   - Events:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.expired`
     - `charge.refunded`
4. Paste the endpoint **signing secret** (`whsec_…`) in the same admin card or as
   `STRIPE_WEBHOOK_SECRET` in `.env`.
5. Set `DEMO_MODE=false`, `NODE_ENV=production`,
   `PUBLIC_BASE_URL=https://api.ketaminecc.website`, `PUBLIC_SITE_URL=https://ketaminecc.website`.
6. Restart/redeploy the server.

A Stripe key always wins over `DEMO_MODE`, so checkout opens real Stripe as soon as the key is
saved. Prices are sent to Stripe dynamically from the admin-managed product records, so editing a
plan in the dashboard changes what Stripe charges on the next checkout. No Stripe product IDs
need to be maintained.

With the current PC + tunnel setup the API hostname can change when the tunnel restarts, so a
fixed webhook URL is not reliable. Fulfillment does not depend on it: the success page calls
`POST /api/orders/:number/sync`, and the server reconciles pending sessions every 5 minutes.
Configure the webhook only if the API moves to a stable hostname.

Test cards: `4242 4242 4242 4242`, any future expiry, any CVC.

---

## 4. Manual payments (Cash App, PayPal, crypto)

Manual checkout works without Stripe business activation, an SSN, or card payments. Stripe
stays in the codebase and takes over again whenever manual checkout is switched off.

1. Open **Admin → Settings → Manual payments**.
2. Fill in any combination of:
   - **Cash App cashtag** — e.g. `$yourname`; the pay page builds `https://cash.app/$yourname/5.99`.
   - **PayPal.me link** — e.g. `https://paypal.me/yourname`; the amount is appended.
   - **Bitcoin / Ethereum / USDT addresses** — separate fields, validated before saving. USDT
     is treated as **ERC-20 on Ethereum**; the payment page warns against other networks.
   - **Crypto notes** — optional extra text shown with the addresses (network warnings, fees).
   - **Discord ticket URL** — optional; falls back to the Discord invite from the main settings.
   - **Checkout instructions** — optional extra text shown on the payment page.
3. Tick **Enable manual checkout** and save. The server refuses to enable it when no method
   is configured.

While enabled, manual checkout **takes priority over Stripe**. `/api/site` reports
`"payments": "manual"`, and the Stripe key is ignored at checkout.

**Buyer flow**

1. Signed-in buyer picks a method on `checkout.html`.
2. `POST /api/checkout` creates an `awaiting_payment` order and returns the order number.
3. `checkout-success.html?order=…` shows the exact amount, order number, a payment link
   (Cash App / PayPal) or live BTC / ETH / USDT amounts with copyable addresses, and the
   ticket link. Crypto totals are converted from USD with cached Coinbase spot rates
   (`GET /api/crypto/rates?amountCents=…`) and can be refreshed on the page.
4. The buyer pays externally, then either submits a transaction ID / sender name on the page
   (`POST /api/orders/:number/claim`) or opens a Discord ticket with the order number.
5. In **Admin → Orders**, filter **Awaiting payment**, verify the payment, then press
   **Confirm**. The license is issued from stock immediately and appears in the buyer's
   dashboard; the success page picks it up by polling.
6. **Cancel** expires an unpaid order. **Mark refunded** revokes the license; send the money
   back in Cash App / PayPal / crypto yourself — there is no Stripe charge to reverse.

When a purchase-log webhook is configured, payment claims also post to Discord, but nothing
is auto-approved: only an admin session can confirm payment or issue the key. If manual
checkout is disabled and no Stripe key is present, checkout shows an offline message instead
of redirecting to a failing Stripe page.

---

## 5. Deploy on your own domain

Two supported layouts:

**A. GitHub Pages static frontend + Render API (split hosting)**
Step-by-step: **`deploy/GITHUB-PAGES.md`**. Pages serves `ketaminecc.website`; Render serves
`api.ketaminecc.website`; `render.yaml` and `.github/workflows/pages.yml` are included.
A Render persistent disk (Starter plan) is required so SQLite survives deploys.

**B. One Ubuntu VPS (everything on one box)**
Step-by-step: **`deploy/SETUP.md`**. Ready-to-copy `deploy/Caddyfile` and
`deploy/ketamine.service` are included.

**C. Static on GitHub Pages + API on your own PC behind a Cloudflare Quick Tunnel (current setup)**
`assets/config.js` probes the public API and `assets/api-base.json` is revalidated on every
page load, so a rotated hostname costs one request instead of a dead site. The loader reads
the same list and caches the last working base in `api.cache.txt`.

- Primary and standby: `cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate`
  (Quick Tunnels; no account and no public IP exposed).
- `scripts/tunnel-watchdog.ps1` keeps the API and both tunnels alive, promotes the standby
  when the primary fails, and republishes the hostnames to `assets/config.js`,
  `assets/api-base.json`, `server/.env`, and the client's `api.txt` / `api.cache.txt`.
- Every page's CSP allows `https://*.trycloudflare.com` for the API origin.
- `scripts/watchdog-launcher.vbs` is copied into the Windows Startup folder so the watchdog
  starts at logon and is restarted 15 seconds after it exits.
- Tunnel hostnames rotate when cloudflared restarts; do not hardcode one elsewhere.
- `CORS_ORIGINS` must match the **exact scheme + host** the browser uses. Include both
  `http://` and `https://` variants while a certificate is pending, or every browser API
  call fails with `Failed to fetch`.
- `localhost` on Windows can resolve to IPv6, so always forward to `127.0.0.1`.
- The PC must stay awake with the server and tunnel running.

Minimum for A and B: one Linux VPS (1 vCPU / 1 GB is enough), your domain's DNS pointed at it.

1. **DNS** — create an `A` record for `ketaminecc.website` (and optionally `www`) pointing to
   the VPS IP. If your registrar offers proxy/CDN, leave it **DNS-only**.
2. **Install** Node.js 22+ and Caddy.
3. **Copy** this folder to `/srv/ketamine` and run `npm install --omit=dev` in `server/`.
4. **Environment** — edit `/srv/ketamine/server/.env`:
   ```ini
   NODE_ENV=production
   PUBLIC_BASE_URL=https://ketaminecc.website
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
   ketaminecc.website, www.ketaminecc.website {
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

## 6. Encrypted Discord purchase log

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
SITE_API_URL=http://localhost:3000      # use https://ketaminecc.website in production
BOT_SHARED_SECRET=…                     # must equal server/.env
OWNER_ID=                               # optional extra owner IDs
```

Restart the bot after editing. Slash commands re-register on boot.

The admin console can also reveal a code under **Settings → Verification codes**.

---

## 7. Admin console

`/admin` — secret-key login, 8-hour session, all actions written to the audit log.

- **Overview** — 30-day revenue/orders, active licenses, expiries, pending orders, refunds.
- **Orders** — search, decrypt details, confirm or cancel manual payments, refund through
  Stripe (or mark manual orders refunded), revoke keys.
- **Licenses** — restock 1–500 unassigned keys at once for any product and duration
  (`lifetime` or days). Checkout consumes stock automatically and stamps the buyer's account
  email on the key; if stock is empty, a key is generated at purchase. Search, revoke,
  blacklist, copy keys.
- **Products** — edit name, tagline, price, duration, features, badge, currency note, sort,
  visibility; create new plans. Changes are live immediately.
- **Customers** — spend, orders, active keys, last login; suspend or restore.
- **Blacklist** — email, license key, IP, or Discord ID; blocked at checkout/registration and
  in the license validation endpoint.
- **Audit log** — admin logins, refunds, key generation, revocations, setting changes.
- **Settings** — brand, support email, Discord invite, purchase webhook, test webhook, manual
  payments (Cash App / PayPal / crypto / ticket URL / instructions), Stripe secret key + webhook
  signing secret (encrypted at rest), Stripe connection test, code reveal, bot status.

Refunds revoke the order's license automatically. Blacklisting a user revokes their active
licenses. Every license check reflects the change immediately.

---

## 8. License validation API (for your software)

```http
GET /api/license/validate?key=KET-XXXXX-XXXXX-XXXXX-XXXXX
```

```json
{
  "valid": true,
  "status": "active",
  "product": "Monthly License",
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
GET  /api/crypto/rates?amountCents=599  live USD→BTC/ETH/USDT quote
POST /api/checkout
GET  /api/orders, /api/orders/:number
POST /api/orders/:number/sync       reconcile a pending Stripe session
POST /api/orders/:number/claim      manual payment claim (buyer)
GET  /api/licenses                  current account keys
POST /api/webhook/stripe
POST /api/internal/reveal          (bot only, X-Bot-Secret)
POST /api/admin/*                  (admin session)
```

---

## 9. Security notes

- Passwords: scrypt with per-user salts.
- Sessions: random 256-bit tokens, only SHA-256 hashes stored. The browser keeps the token
  in `localStorage` and sends it as a bearer token (cookies also work on same-origin setups).
- License keys and Discord payloads: AES-256-GCM with a server-side key.
- Stripe: raw-body signature verification before fulfillment.
- CSP, frame denial, nosniff, referrer and permissions policies.
- In-memory rate limits on auth, checkout, manual payment claims, admin login, validation, and
  bot reveal.
- Origin checks on state-changing requests; explicit static-file allowlist so `/server`
  (including `.env`) is never served.
- Demo mode must be off in production or keys can be issued without payment.

### Before going live

- [ ] `DEMO_MODE=false`
- [ ] `NODE_ENV=production`, HTTPS base URL
- [ ] Stripe live keys (env or Admin → Settings) + optional webhook signing secret, **or**
      manual payments configured and enabled
- [ ] Payment claims reach you (Discord webhook or ticket URL) if manual checkout is on
- [ ] Custom-domain TLS issued and Enforce HTTPS on
- [ ] Fresh secrets if this folder was ever shared (`SESSION_SECRET`, `ENC_KEY`,
      `BOT_SHARED_SECRET`); rotating `ENC_KEY` makes existing rows unreadable
- [ ] Change the admin secret from the setup value
- [ ] Back up `store.db` + `ENC_KEY`
- [ ] Remove `node_modules` from any copy you upload (reinstall on the server)

---

## 10. Holiday decal

`assets/santa-hat.png` is the supplied decal, used on the storefront, login, and admin screens.
It is a transparent PNG rendered at its natural aspect ratio; swap the file (same name) to change it.

---

## 11. Snowfall

`assets/app.js` draws six-armed snowflakes on a canvas with depth, sway, rotation, and
DPI scaling. It pauses when the tab is hidden, hides on reduced-motion, and is disabled on
the admin console via `data-snow="off"`.
