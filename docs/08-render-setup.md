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
| Start Command | `npm run start` | Applies pending database migrations (`prisma migrate deploy`), then starts `react-router-serve`. A deploy can no longer run new code against an old schema. |
| Health Check Path | `/healthz` | Returns 200 from memory, never queries Neon. |

**Node version:** `package.json` declares `engines.node >= 22.0.0`. Render reads this
and picks Node 22+. If you must pin it, set `NODE_VERSION=22` as an env var.

### Do NOT use the Docker path
There is a `docker-start` script (`npm run setup && npm run start`) but **no Dockerfile**
in the repo. Ignore it.

### Do NOT put `npm run setup` in the build command
`setup` is now just `prisma generate`. Migrations are **not** part of the build,
because `migrate deploy` needs a reachable database and exits non-zero if
`DATABASE_URL` is briefly unreachable — that aborts the deploy.

Build command:

```
npm ci && npm run build
```

Migrations run automatically at start (`npm run start`). If the database is
unreachable the service fails to boot and Render keeps the previous version
live. To run them by hand instead:

```bash
DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require" npx prisma migrate deploy
```

### `prisma` must be a regular dependency, not a devDependency
Render's build runs `npm ci` with devDependencies omitted. If `prisma` is only in
`devDependencies`, the `prisma` binary is never installed and the build dies with
`sh: 1: prisma: not found`. It has to be in `dependencies` so `prisma generate`
works at build time. `@prisma/client` declares `prisma` as a *peer* dependency,
so it will not be pulled in automatically — this has to be explicit.

### Why `.npmrc` exists — do not delete it
Render omits devDependencies, but `react-router build` loads `vite.config.ts`,
which imports `vite` and `vite-tsconfig-paths`. Without them the build dies with
`Cannot find package 'vite-tsconfig-paths'`.

`.npmrc` contains `include=dev`, which re-adds devDependencies for the install
while keeping the production omit for the deployed image. Do not "fix" this by
moving build tools into `dependencies` one at a time — that is what caused the
prisma failure. `npm run check:build-deps` guards both: it fails if `.npmrc`
loses `include=dev`, or if a build config imports a package that is not declared
at all.

Note the install count is the quickest tell. A full install is ~337 packages;
if Render reports roughly 248, devDependencies were dropped.

### Migration ordering — do not rename these back
`prisma migrate deploy` applies migrations in **lexicographic timestamp order**.
The two migrations must be:

```
20261001050455_init                   (creates Shop + 5 other tables)
20261001060000_options_json_default   (ALTER TABLE "Shop" ...)
```

An earlier revision timestamped the ALTER `20261001000100`, which sorts *before*
`init`. On an empty database that fails with `relation "Shop" does not exist`
(SQLSTATE 42P01) and blocks every later migration, so the app can never find the
`Session` table. `init` creates `optionsJson` as `TEXT NOT NULL` only; the
`DEFAULT '[]'` arrives in the second migration, so `init` alone is not enough.

Recovery from a half-applied failure: Prisma records the failed migration with
`finished_at = NULL`, so it is neither applied nor rolled back and blocks
everything after it. Clear it with:

```bash
npx prisma migrate resolve --rolled-back <migration_name>
npx prisma migrate deploy
```

### Test database guard
`tests/db-invariants.test.ts` refuses to run unless `DATABASE_URL` names a
`*_test` database, because it truncates tables between tests. To run it, create
a separate Neon branch or database whose name contains `_test` and point
`DATABASE_URL` at that. Never point it at production.


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
