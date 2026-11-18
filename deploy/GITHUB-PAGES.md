# GitHub Pages (frontend) + Render (API)

GitHub Pages serves only static files. The API, database, Stripe webhooks, admin
sessions, and bot bridge run on Render.

- Storefront: `https://ketaminecc.website` (GitHub Pages)
- API: `https://api.ketaminecc.website` (Render)
- DNS: GoDaddy
- No Cloudflare.

---

## 1. Push the source to GitHub

Install Git for Windows (or use GitHub Desktop), then from the project folder:

```powershell
git init -b main
git add .
git commit -m "Ketamine.cc store"
git remote add origin https://github.com/<USER>/<REPO>.git
git push -u origin main
```

`.gitignore` already excludes `server/.env`, `server/data`, and `node_modules`.
Never commit real secrets.

> GitHub Pages for a **private** repository requires GitHub Pro. On a free account,
> the repository must be public. No secrets live in the repo, but the source is visible.

---

## 2. Enable GitHub Pages

Repository → **Settings → Pages**:

1. Source: **GitHub Actions**.
2. Custom domain: `www.ketaminecc.website` → Save. The apex `ketaminecc.website`
   redirects to `www`.
3. Wait for the DNS check to pass, then enable **Enforce HTTPS**. The certificate can
   take a few minutes to issue; HTTPS fails until it does.

Every push to `main` runs `.github/workflows/pages.yml`, which publishes only the
static files (`*.html`, `assets/`, `downloads/`, `CNAME`, `.nojekyll`, `robots.txt`).

---

## 3. GoDaddy DNS

Domain → **DNS**. Delete every GoDaddy parked-page `A` record (typically
`3.33.130.190` and `15.197.148.33`) and any domain forwarding. Only the GitHub
records below should remain for `@`.

Add for GitHub Pages:

| Type  | Name | Value                    |
|-------|------|--------------------------|
| A     | @    | 185.199.108.153          |
| A     | @    | 185.199.109.153          |
| A     | @    | 185.199.110.153          |
| A     | @    | 185.199.111.153          |
| AAAA  | @    | 2606:50c0:8000::153      |
| AAAA  | @    | 2606:50c0:8001::153      |
| AAAA  | @    | 2606:50c0:8002::153      |
| AAAA  | @    | 2606:50c0:8003::153      |
| CNAME | www  | `Ketaminecc.github.io`   |
| CNAME | api  | `<SERVICE>.onrender.com` |

`api` is added after Render gives you the service hostname (step 4).

---

## 4. Render API

1. Create a Render account and connect GitHub.
2. **New → Blueprint**, pick the repository. `render.yaml` creates:
   - web service `ketamine-api`, root `server/`,
   - build `npm ci --omit=dev`, start `node src/server.js`,
   - health check `/api/health`,
   - 1 GB persistent disk mounted at `/opt/render/project/src/server/data`.
3. Fill the prompted secrets:
   - `SESSION_SECRET` (64 hex chars)
   - `ENC_KEY` (exactly 64 hex chars; back it up — required to decrypt existing keys)
   - `ADMIN_SECRET` (your admin secret from `server/.env`)
   - `BOT_SHARED_SECRET` (same as `ketaminebot`)
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `DISCORD_PURCHASE_WEBHOOK_URL` (optional)
4. Service → **Settings → Custom Domains** → add `api.ketaminecc.website`.
   Render shows a target like `ketamine-api.onrender.com`; put that in the GoDaddy
   `api` CNAME record.
5. Confirm `https://api.ketaminecc.website/api/health` returns `{"ok":true}`.

The persistent disk requires the **Starter** plan (about $7/mo). Without a disk,
SQLite is erased on every deploy/restart and every license is lost.

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Render sets `PORT`; the app reads it automatically. Do not set `PORT` manually.

---

## 5. Stripe

Dashboard → Developers → Webhooks → Add endpoint:

- URL: `https://api.ketaminecc.website/api/webhook/stripe`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.expired`, `charge.refunded`

Put the signing secret in Render's `STRIPE_WEBHOOK_SECRET`, then redeploy.
Stripe success/cancel URLs use `PUBLIC_SITE_URL`, so buyers return to GitHub Pages.

---

## 6. Discord bot

`C:\Users\angel\OneDrive\Documents\ketaminebot\.env`:

```ini
SITE_API_URL=https://api.ketaminecc.website
BOT_SHARED_SECRET=<same as Render>
OWNER_ID=<your Discord user ID>
```

Restart the bot, run `/verify` as the owner.

---

## 7. Cookies and previews

Production uses `api.ketaminecc.website` + `ketaminecc.website`: same site, so
`COOKIE_SAME_SITE=lax` works and auth cookies are sent on API calls.

If you test the `*.github.io` preview against `*.onrender.com`, that is cross-site:
set `COOKIE_SAME_SITE=none` and add the preview origin to `CORS_ORIGINS` temporarily.
Chrome may still block third-party cookies; test the real domain for checkout.

---

## 8. Verification

```powershell
nslookup ketaminecc.website 8.8.8.8
nslookup api.ketaminecc.website 8.8.8.8
curl.exe -I https://ketaminecc.website
curl.exe https://api.ketaminecc.website/api/health
```

Then in a browser: register → purchase (demo or Stripe test) → key appears on
`/dashboard.html` → admin login at `/admin.html`.

---

## 9. Updating

```powershell
git add .
git commit -m "update"
git push
```

Pages redeploys the static files; Render redeploys the API. The database stays on
the Render disk.
