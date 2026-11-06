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
- [ ] Set your **support email and privacy policy URL** in the listing. The app
      shows `sourcetracsupport@gmail.com` (the `SUPPORT_EMAIL` constant in
      `shared/support.ts`); use the same address in the listing. The privacy
      policy is served at `<APP_URL>/privacy`.

---

## 4. App Store listing copy

Deliberately contains **no statistics, no competitor comparisons, and no
performance claims** — only verifiable product behaviour.

**Subtitle:** Know where every order came from.

**Description:**
SourceTrac adds a short post-purchase survey to your Shopify Thank you page
(and, if you choose, the Order status page) and shows you which channels and
answers bring in revenue.

- Start from a ready-made survey such as "How did you hear about us?", with
  answer lists suggested for your market, or build your own with up to 5
  questions: single or multiple choice, dropdown, yes/no, rating, satisfaction,
  0-10 recommendation score and free text, with follow-up questions.
- The survey uses your checkout's own branding automatically.
- See answers, revenue and average order value per channel and per answer,
  NPS and satisfaction scores, first-time and returning buyers, and daily trends
  in your store's time zone.
- Download every answer as a CSV file.
- Revenue is kept separate per currency, never added across currencies.

**Pricing (as billed through Shopify):**
- Free: up to 50 answers a month, 1 live survey.
- Growth: $4.99 a month, or $53.89 a year.
- Scale: $9.99 a month, or $107.89 a year.
- Growth and Scale include a 14-day free trial, once per store. You're charged
  only if the plan is still active when the trial ends.

Billing is handled by Shopify; there is no separate account.

---

## 5. Submission checklist

- [ ] `npm run check` passes (typecheck, extension typecheck, extension target check, tests).
- [ ] Production build succeeds and `/healthz` is green.
- [ ] OAuth install works on a fresh store.
- [ ] Survey renders on both Thank you and Order status in a real order.
- [ ] Privacy policy URL is live and lists the fields collected: order ID, channel, timestamp.
- [ ] GDPR webhooks registered: `customers/data_request`, `customers/redact`, `shop/redact`.
- [ ] Scopes are `read_orders,write_orders,write_customers,read_products`, with a justification for each write scope in the listing review notes (protected-customer-data Level 1; no names/emails/phones/addresses read or stored).
- [ ] Existing merchants re-approve the new scopes; a store that has not, still works with sync skipped (test on a store with only `read_orders`).
- [ ] App uninstalled and reinstalled cleanly (no stale tokens, no crash).
- [ ] Screenshots captured on a real dev store.
- [ ] No placeholder text, no TODOs, no console noise in the submitted build.