# Deploying SourceTrac

Written 2026-10-02. Everything here was verified against the code in this
repo, not assumed.

## Read this first

Two things will make a deploy look like it worked when it did not.

**1. `shopify app deploy` only uploads extensions and app config.** It does
not deploy your backend. There is no Dockerfile in this repo, so nothing about
the Node server is published by that command. Render must be configured
separately, and it must already be serving the same commit.

**2. The dashboard will render but the survey will not** if the Partner
Dashboard network-access opt-in is missing. `network_access = true` is set in
both extension TOMLs, but Shopify only honours it once you enable network
access for your app in the Partner Dashboard. Until you do, the extension
cannot call `fetch`, and the survey block silently renders nothing — no error,
nothing in the logs. This is the single most likely cause of "the survey never
appears".

## Order of operations

Do these in order. Steps 3 and 5 have hard dependencies on the ones before.

### 1. Provision the database (Neon)

Create a Neon project. Use the **pooled** connection string for `DATABASE_URL`
(`-pooler` in the hostname) — Render opens many connections and the direct
endpoint caps out.

Apply the migrations before anything else talks to the database:

```sh
export DATABASE_URL='postgresql://USER:PASSWORD@ep-xxx-pooler.aws.neon.tech/neondb?sslmode=require'
npx prisma migrate deploy
```

`migrate deploy` applies committed migrations only. It will not prompt and it
will not create a shadow database. If it prints "No pending migrations", your
database is already current.

### 2. Get the app URL

You need the final HTTPS URL before step 4, because two separate places must
agree on it:

- `APP_URL` and `API_URL` (env vars, read at runtime)
- `application_url` and `redirect_urls` in `shopify.app.toml`
- `allowed_urls` / network-access opt-in in the Partner Dashboard

If your Render service is not yet at `sourcetrac.onrender.com`, fix that first.
A mismatch here does not throw — it just produces a redirect loop or a blank
panel.

### 3. Deploy the backend (Render)

There is no `Dockerfile` and no `render.yaml` in this repo, so set the service
up by hand:

| Setting | Value |
| --- | --- |
| Root directory | repository root |
| Build command | `npm ci && npx prisma generate && npm run build` |
| Start command | `npm run start` (runs migrations first) |
| Node version | 20 or newer |
| Health check path | `/healthz` |

`npm ci` rather than `npm install`: the repo sets `include=dev` in `.npmrc` on
purpose, because `prisma generate` and the build both need devDependencies.
`npm ci --omit=dev` would break the build.

Environment variables, all of them required:

```
DATABASE_URL             Neon pooled URL (see step 1)
SHOPIFY_API_KEY          from Partner Dashboard
SHOPIFY_API_SECRET       from Partner Dashboard
SCOPES                   read_orders
SHOPIFY_API_VERSION      2026-07
APP_URL                  https://sourcetrac.onrender.com
API_URL                  https://sourcetrac.onrender.com
NODE_ENV                 production
TOKEN_ENCRYPTION_KEY     openssl rand -hex 32
SUPPORT_EMAIL            your support address
```

`app/lib/env.ts` validates all of these at boot with a Zod schema and throws
on anything missing or malformed. A bad `TOKEN_ENCRYPTION_KEY` (not 64 hex
characters) or a non-absolute `APP_URL` will crash the process on start rather
than fail quietly later.

**Do not reuse a `TOKEN_ENCRYPTION_KEY` from a previous deploy.** Tokens are
encrypted with AES-256-GCM under that key. Changing it orphans every stored
access token and locks out every installed shop.

### 4. Enable network access (Partner Dashboard)

Apps → your app → Configuration → **Allow network access in checkout UI
extensions**. This is self-serve and auto-approved, but the deployment is
incomplete without it.

Without it: the extension loads, `fetch` fails silently, no survey appears.

### 5. Deploy the extensions and app config

Only now, with Render serving and network access enabled:

```sh
shopify app deploy
```

This uploads both UI extensions and syncs the webhook subscriptions and access
scopes from `shopify.app.toml`. It does **not** touch Render.

Then, in the Partner Dashboard, confirm the subscriptions registered:

- `orders/create`, `orders/updated`, `orders/cancelled`
- `app/uninstalled`, `app/scopes_update`
- `app_subscriptions/update`
- `customers/data_request`, `customers/redact`, `shop/redact`

The three GDPR topics are mandatory. Their absence is an App Store rejection.

## Verifying the deploy

```sh
# Health. Must return 200 and must NOT touch the database.
curl -i https://sourcetrac.onrender.com/healthz
```

`/healthz` deliberately never queries Postgres, so a 200 does not prove your
`DATABASE_URL` works. To check that separately, hit the app itself — loading
the dashboard in the admin iframe exercises a real query.

Then check the log output for `plans_reconcile_failed` or any
`Invalid environment configuration` error. The second one means a required
variable is wrong and the process may have crashed on boot.

## Local verification before you deploy

```sh
npm ci
cp .env.example .env      # then fill it in
npx prisma migrate deploy
npm run check             # typecheck, extension config, build deps, tests
```

`npm run check` must exit 0 before you deploy. It runs 222 tests across 13
files and needs a `*_test` database for the DB invariant suite.

## Known gap: no retention purge job exists

The docs promise 24-month retention for responses and orders and 30-day
retention for webhook payloads (`docs/02-architecture-and-costs.md` §retention).
**No code implements this.** There is no `jobs.server.ts`, no `deleteMany`, and
no scheduled endpoint. Rows are only deleted by the GDPR redact webhooks and
shop-uninstall cascades.

This does not break the deploy, but it means storage grows without bound. See
the capacity note below before relying on the free tier.

## Capacity on the Neon free plan

Measured, not estimated — 2,000 realistic rows inserted per table into Postgres
16, then read back with `pg_total_relation_size`:

| Table | Rows | Bytes/row (incl. indexes) |
| --- | --- | --- |
| `SurveyResponse` | 2,000 | 495 |
| `WebhookEvent` | 2,000 | 496 |
| `OrderCache` | 2,000 | 356 |

The free plan gives **0.5 GB of storage**, so roughly:

- **Responses + orders only: ~590,000 orders** (851 bytes each).
- **Including webhook payloads: ~370,000 orders** (1,347 bytes each) — but only
  if the 30-day purge exists. Without it, webhook payloads accumulate forever.

A merchant doing 2,000 orders/month consumes ~2.7 MB/month (or ~16 MB/month
with undeleted webhook payloads). **You have room for roughly 25–30 such
merchants before storage, not compute, becomes the limit.**

The binding constraint on the free tier is almost certainly the **100 compute
hours/month** budget, not the 0.5 GB. Read that number next to your own
traffic: a cold Neon project suspends after 5 minutes of inactivity, and each
cold start costs compute hours.
