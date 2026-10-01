# SourceTrac — File Tree & Environment Variables

The annotated tree lives in `02-architecture-and-costs.md` §7. This file covers the environment contract, which is what you actually need before writing `.env`.

---

## Environment variables

### Backend / shared

| Variable | Required | Example | Notes |
|---|---|---|---|
| `SHOPIFY_API_KEY` | ✅ | `a1b2c3...` | App client ID. Used as the expected JWT `aud`. |
| `SHOPIFY_API_SECRET` | ✅ | `shpss_...` | App secret. Verifies webhook HMAC **and** extension session-token JWTs. Server-side only. |
| `SCOPES` | ✅ | `read_orders` | Single scope. Keep in sync with `shopify.app.toml`. |
| `DATABASE_URL` | ✅ | `postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require` | Use the **pooled** connection string for the server, not the direct one. |
| `TOKEN_ENCRYPTION_KEY` | ✅ | 32-byte hex | AES-256-GCM key for `access_token_encrypted`. Generate: `openssl rand -hex 32`. **Rotating this without re-encrypting orphans every token.** |
| `APP_URL` | ✅ | `https://sourcetrac.onrender.com` | Public base URL. Used for `returnUrl`, webhook registration, and absolute links. Must be HTTPS. |
| `API_URL` | ✅ | `https://sourcetrac.onrender.com` | Same URL, read by both checkout UI extensions at **build time**. Must match `APP_URL` and each extension's `allowed_urls`. |
| `SHOPIFY_API_VERSION` | ✅ | `2026-07` | Keep identical to `shopify.app.toml`. |
| `NODE_ENV` | ✅ | `production` | |
| `LOG_LEVEL` | | `info` | `debug` in development. |
| `SUPPORT_EMAIL` | | `support@example.com` | Shown on the Help page. |
| `PUBLIC_EXTENSION_CHECKOUT_TARGET` | | `purchase.thank-you.block.render` | Sanity-check constant used in a startup assertion. |
| `PUBLIC_EXTENSION_ORDER_STATUS_TARGET` | | `customer-account.order-status.block.render` | |

### Billing (Shopify Billing API path)

| Variable | Required | Notes |
|---|---|---|
| `SHOPIFY_APP_ID` | ✅ | Needed for billing flows and the Admin API app GID. |

> **Not needed today:** `PARTNER_API_CLIENT_TOKEN`, `PARTNER_ORG_ID`. Only add these if you migrate to Shopify App Pricing (finding A12).

### Extension build-time (baked into the bundle by `shopify app dev/deploy`)

| Variable | Notes |
|---|---|
| `API_URL` | Our backend base. Set in each extension's `.env` or passed via CLI. Must match a host in the extension's `allowed_urls`. |

---

## Rules that are easy to get wrong

1. **`APP_URL` must be the deployed URL**, not `localhost`. Local dev uses the Shopify CLI tunnel URL instead; don't commit a tunnel URL.
2. **`SHOPIFY_API_SECRET` in the extension would be a security hole.** Extensions get a *session token* (JWT) per request. There is no shared secret in extension code. If you find yourself wanting one, you want an App Proxy or a metafield instead.
3. **Never commit `.env`.** `.env.example` is committed with placeholder values only.
4. **`DATABASE_URL` on Render** should be set as a **secret**, not in `render.yaml` committed to git.
5. **Build-time vs runtime.** `SHOPIFY_API_KEY`, `SCOPES`, and `SHOPIFY_API_VERSION` are embedded at build time by the CLI. `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, and `SHOPIFY_API_SECRET` are read at runtime. Don't hardcode the latter in the bundle.
6. **Cold starts lose in-memory state.** Our rate limiter is in-memory by design (FLOW 13). After a spin-down the limiter resets — acceptable, and documented.

---

## Where things go

| Concern | Location |
|---|---|
| Public extension API routes | `app/routes/public.*.ts` — **no session cookie auth**, JWT only |
| Shopify webhooks | `app/routes/webhooks.ts` — HMAC only, no session |
| Embedded admin pages | `app/routes/app.*.tsx` — `authenticate.admin` session |
| OAuth callback | `app/routes/auth.$.tsx` |
| Health check (no DB) | `app/routes/healthz.ts` — imports **nothing** from `db.server` |
| Database client | `app/db.server.ts` — single pooled Prisma client, reused across hot reloads in dev |
| Admin GraphQL wrapper | `app/lib/shopify.server.ts` — adds 429/backoff handling so no route does it ad hoc |
| Extension fetch/retry client | `extensions/*/src/api.ts` — the only place `fetch` to our backend is called |

---

## Testing hooks

Unit and integration tests import from `app/lib/*` directly (pure functions where possible) and use a **real** Postgres for DB-dependent tests — not mocks. See `tests/helpers/db.ts`. A `TEST_DATABASE_URL` env var selects the test database; tests refuse to run against a non-`_test` database name to prevent wiping production.
