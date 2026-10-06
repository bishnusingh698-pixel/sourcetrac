# SourceTrac — Deploy, listing copy, and App Store submission

---

## 1. Environment variables

Copy `.env.example` to `.env` and fill in real values. See that file for the
annotated list; the required ones are:

| Variable | Where it comes from |
|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES` | Partner Dashboard → your app → Settings |
| `SESSION_SECRET` | Any long random string (`openssl rand -hex 32`) |
| `DATABASE_URL` | Neon connection string, `?sslmode=require` |
| `APP_URL` | Your Render URL — must match `shopify.app.toml` exactly |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` — encrypts stored access tokens at rest |

---

## 2. Deploy to Render

1. Create a **Web Service** from your repo.
2. Build command: `npm ci && npm run build`
3. Start command: `npm run start` (applies database migrations, then starts the server)
4. Health check path: `/healthz`
5. Add all env vars from §1. Add `NODE_ENV=production`.
6. Deploy, then confirm `https://<service>.onrender.com/healthz` returns 200.

### Database
```bash
# In Neon console: create a branch for previews, keep main as production.
npm run prisma:deploy   # prisma migrate deploy
npm run prisma:generate
```

### First-time setup
1. In Partner Dashboard, replace `client_id`, `application_url`, and both
   `redirect_urls` in `shopify.app.toml` with your Render URL.
2. Set `network_access = true` under `[extensions.capabilities]` in **each**
   extension's `shopify.extension.toml`.
3. Run `shopify app dev` once, complete an install, and confirm the survey renders.

---

## 3. What you must do manually (cannot be automated)

- [ ] Create a **Partner account** and register the app.
- [ ] Request **protected customer data** access if you later want order PII —
      v1.0 does not require it (only order ID + total are cached).
- [ ] Configure **App Store listing**: name, category, screenshots, and the copy in §4.
- [ ] Submit for **App Store review**. Typical review turnaround is several days.
- [ ] Set your **support email and privacy policy URL** in the listing.

---

## 4. App Store listing copy

Deliberately contains **no statistics, no competitor comparisons, and no
performance claims** — only verifiable product behaviour.

**Subtitle:** Know where every order came from.

**Description:**
SourceTrac asks one question — "How did you hear about us?" — on your Shopify
thank-you page and order status page, then shows you which channels actually
drive revenue.

- Set your own question and 6–10 answer channels, with optional emoji.
- One tap for buyers. It inherits your checkout theme automatically.
- See responses, revenue and average order value per channel, with 7/30/90-day trends.
- Export every answer to CSV (order ID, timestamp, channel, order total, currency).
- Currencies are always kept separate and summed correctly.

**Pricing:** Free up to 50 responses/month. Growth $19/month. Scale $49/month.
Billing is handled by Shopify — no separate account.

---

## 5. Submission checklist

- [ ] `npm run check` passes (typecheck, extension typecheck, extension target check, tests).
- [ ] Production build succeeds and `/healthz` is green.
- [ ] OAuth install works on a fresh store.
- [ ] Survey renders on both Thank you and Order status in a real order.
- [ ] Privacy policy URL is live and lists the fields collected: order ID, channel, timestamp.
- [ ] GDPR webhooks registered: `customers/data_request`, `customers/redact`, `shop/redact`.
- [ ] `read_orders` is the only scope, with a justification in the listing review notes.
- [ ] App uninstalled and reinstalled cleanly (no stale tokens, no crash).
- [ ] Screenshots captured on a real dev store.
- [ ] No placeholder text, no TODOs, no console noise in the submitted build.