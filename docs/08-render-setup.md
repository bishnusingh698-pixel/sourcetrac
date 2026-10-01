# SourceTrac — Render setup (exact values)

Every command below was read from this repo's `package.json`, not from memory.

---

## 1. Create the service

Render dashboard → **New +** → **Web Service** → connect `bishnusingh698-pixel/sourcetrac`.

| Field | Value | Why |
|---|---|---|
| Branch | `sourcetrac-v1` | That's where the code is. |
| Root Directory | *(blank)* | Monorepo root. |
| Runtime | Node | No `Dockerfile` exists in this repo. |
| Build Command | `npm ci && npm run build` | `build` = `react-router build`. `npm ci` (not `--omit=dev`) because Vite, `@react-router/dev` and `tsc` are devDependencies needed to build. |
| Start Command | `npm run start` | `react-router-serve ./build/server/index.js`. |
| Health Check Path | `/healthz` | Returns 200 from memory, never queries Neon. |

**Node version:** `package.json` declares `engines.node >= 22.0.0`. Render reads this
and picks Node 22+. If you must pin it, set `NODE_VERSION=22` as an env var.

### Do NOT use the Docker path
There is a `docker-start` script (`npm run setup && npm run start`) but **no Dockerfile**
in the repo. Ignore it.

### Do NOT put `npm run setup` in the build command
`setup` = `prisma generate && prisma migrate deploy`. `migrate deploy` needs a
reachable database, so if `DATABASE_URL` is even briefly unreachable the build
aborts on a non-zero exit and the deploy fails. Use `npm ci && npm run build`
and run migrations once by hand:

```bash
DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require" npx prisma migrate deploy
```

### The ui-extensions versions are pinned together on purpose
`@shopify/ui-extensions` and `@shopify/ui-extensions-react` must be the **same**
version — the React package declares an exact-version peer on the core package,
not a range. Mismatched versions fail `npm ci` with `ERESOLVE` before the build
ever starts. Both are pinned to `2025.7.4`; bump them together or not at all.

**This does not mean the app targets an old Shopify API.** The npm package version
and the declared `api_version` are separate. The extensions declare
`api_version = "2026-07"` in `shopify.extension.toml` and the backend calls
`SHOPIFY_API_VERSION=2026-07`. The 2025.7.4 package only determines *which
binding* is available: 2026.x ships a Preact binding, 2025.7.x ships the
React/remote-ui binding this code is written against. See AGENTS.md for the
migration path if Shopify publishes a 2026.x React binding.

---

## 2. Environment variables

Render → your service → **Environment**. Add all of these:

```
NODE_VERSION=22
NODE_ENV=production
LOG_LEVEL=info

# From Neon — use the POOLED connection string, not the direct one
DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.aws.neon.tech/neondb?sslmode=require

# From Partner Dashboard → your app → Settings
SHOPIFY_API_KEY=your_client_id
SHOPIFY_API_SECRET=shpss_...
SHOPIFY_API_VERSION=2026-07
SCOPES=read_orders

# Must be the render URL EXACTLY. No trailing slash.
# First deploy: set it to the URL render gave you, then redeploy.
APP_URL=https://<service>.onrender.com

# REQUIRED. 64 hex chars. Encrypts stored access tokens.
TOKEN_ENCRYPTION_KEY=<output of: openssl rand -hex 32>

SUPPORT_EMAIL=you@yourdomain.com
```

> **`TOKEN_ENCRYPTION_KEY` is required, not optional.** `app/lib/env.ts` validates it
> as exactly 64 hex characters — a short or non-hex value fails the whole boot, not
> just token encryption. It encrypts stored access tokens; rotating it without
> re-encrypting existing rows locks every shop out of the app. Set it once, keep it
> in Render's secret storage, never in a commit.

### Required vs optional
`app/lib/env.ts` hard-requires all seven of: `DATABASE_URL`, `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOPIFY_API_VERSION`, `SCOPES`, `APP_URL`,
`TOKEN_ENCRYPTION_KEY`. Optional: `SUPPORT_EMAIL`, `LOG_LEVEL`, `NODE_ENV`
(defaults to `development`).

If any required one is missing the app **fails at boot** rather than crashing later —
you'll see it immediately on `/healthz`.

---

## 3. Database migrations

Neon console → create the database → copy the **pooled** connection string.

Run migrations once, from your laptop, pointed at the same database:

```bash
DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require" npx prisma migrate deploy
```

**Alternative — let Render do it every deploy.** Change the Build Command to:
```
npm ci && npm run setup && npm run build
```
`setup` = `prisma generate && prisma migrate deploy`. Idempotent, so re-running on
every deploy is safe. This is the recommended option — it removes the manual step and
guarantees migrations never drift from the deployed code.

---

## 4. After the first deploy

1. Confirm liveness:
   ```bash
   curl https://<service>.onrender.com/healthz
   ```
   Expect `{"status":"ok","service":"sourcetrac","booted_at":"..."}`.

2. Confirm the DB is actually reachable (`/readyz` **does** query the database —
   this is the deliberate counterpart to `/healthz`):
   ```bash
   curl https://<service>.onrender.com/readyz
   ```

3. Copy the URL into `shopify.app.toml` (4 places: `client_id`, `application_url`,
   and both `redirect_urls`) and into Partner Dashboard → App URL.

4. Redeploy so the app picks up the final `APP_URL`.

---

## 5. Free tier reality

Verified 2026-10-01 against render.com/docs/free and render.com/pricing:

- **512 MB RAM, 0.1 CPU**, 750 free instance hours per workspace per month
- Spins down after **15 minutes** idle; spin-up takes **~1 minute**
- Free Postgres expires 30 days after creation — **not usable**; use Neon

So the cold start is real. This is already handled: the extension retries with
backoff for ~60s and hides the survey only after final failure. `/healthz` being
DB-free is what stops your uptime pinger from burning Neon compute hours.

If 750 hrs/month is shared with other Render services in the same workspace,
verify your actual allocation in the Render dashboard.

**Escape hatch if cold starts hurt:** Render's cheapest paid web service is
**$7/month** ("Less than 1 CPU / 512 MB RAM"). Verified 2026-10-01 at
https://render.com/pricing.

**Non-sleeping free alternative:** Northflank's Sandbox tier is documented as
"Always-on-compute – no sleeping". Verified 2026-10-01 at
https://northflank.com/pricing. Fly.io was dropped — their pricing page documents
no free allowance for new orgs.

---

## 6. Then do this

```bash
shopify app dev          # or push the branch and deploy via Partner Dashboard
shopify app generate extension
```

Complete an install on your dev store and confirm the survey renders on both the
Thank-you and Order status pages.
