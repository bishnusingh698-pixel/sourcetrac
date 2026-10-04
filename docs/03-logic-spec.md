# SourceTrac — Numbered Logic Specification

Every flow is numbered. Each states: trigger → steps → failure modes → exact observable behaviour. This document is the contract; Phase 2–4 code implements it and Phase 5 tests assert it.

Terminology: **shop** = one merchant store. **order GID** = `gid://shopify/Order/{id}`.

---

## FLOW 1 — Survey renders on Thank-you page

**Trigger:** `purchase.thank-you.block.render` fires after a buyer completes checkout.

1. Extension reads the order GID from `useExtensionApi().order` (`OrderConfirmationApi.order.confirmationNumber` for display, `orderId` for identity). Shopify confirms the ID is available even though the order is not yet created.
2. Extension calls `GET /public/survey-config` with `Authorization: Bearer <fresh session token>`.
3. Backend verifies the JWT (FLOW 10). Extracts `dest` → shop domain. **This is the only source of shop identity.**
4. Backend loads the shop. Returns `{supported, question, options[], allow_other, currency, cap_exceeded}`.

**Failure modes**

| Condition | Backend response | Extension behaviour |
|---|---|---|
| JWT invalid/expired/missing | `401 {error:"unauthorized"}` | Log `survey_config_unauthorized`. Render **nothing**. Never show an error to the buyer. |
| Shop not found (never installed) | `404` | Render nothing. Log. |
| Shop is Starter / `supported=false` | `200 {supported:false}` | Render nothing. Log `survey_unsupported_plan`. |
| Backend cold start / 5xx / timeout | 502/503/timeout | Retry per FLOW 12. On final failure: render nothing. **Never block the page.** |
| Rate limited by us (429) | `429` + `Retry-After` | Honour `Retry-After`, then retry. |
| Response malformed / missing `question` | — | Treat as backend failure → retry then hide. |

**Never:** show a spinner that blocks the Thank-you page, throw, or render partially-parsed config.

---

## FLOW 2 — Buyer taps an option

**Trigger:** buyer taps one option in the `s-choice-list`.

1. **Immediate visual state change** to a "thanks / submitting" state. The buyer's tap always feels acknowledged, regardless of network outcome.
2. Extension stores the answer in an **in-memory module-scoped variable** (`pendingAnswer`). This survives re-renders, not page navigation.
3. Extension marks `hasSubmittedLocally = true` **before** the network call. All subsequent renders show the confirmation state.
4. Extension calls `POST /public/responses` (FLOW 3).

**Double-tap guard (client side):** `hasSubmittedLocally` is set synchronously before any `await`. A second tap within the same tick finds it already `true` and returns immediately. Combined with the server-side unique constraint (FLOW 3), double-tap cannot create two rows.

**Failure mode:** any thrown error inside this flow is caught by the extension's `unhandledrejection` listener and by the local try/catch. Neither is swallowed — both log via `console.warn(JSON.stringify({event, order_id, error}))` and route into FLOW 12's retry.

---

## FLOW 3 — Recording a response (duplicate / double-tap / refresh)

**Trigger:** `POST /public/responses` with `{order_id, channel, locale}`.

1. Verify JWT → shop (FLOW 10). Reject on failure with `401`.
2. **Validate input.** `order_id` must match `^gid://shopify/Order/\d+$`. `channel` must be one of the shop's configured option values **or** `other`. Reject with `400 {error, field, hint}`.
3. **Idempotency first.** Attempt `INSERT` into `survey_responses`. The table has `@@unique([shop_id, order_id])`.
   - Insert succeeds → new response. Continue to step 4.
   - Unique-violation (`P2002`) → **a response for this order already exists.** Return `200 {status:"duplicate"}`. Do **not** update the existing row. Do **not** error.
4. **Check Free cap.** Read `billing_usage` for the current UTC period.
   - If `responses_count >= cap` (cap = 50 on Free, `null` on paid): insert **still happened**, but set `is_locked = true` on the row. Increment `responses_count` anyway so the admin sees true volume. Return `200 {status:"locked"}`.
   - Else increment `responses_count`. Return `200 {status:"recorded"}`.
5. **Try reconciliation.** If `orders_cache` already has this order, backfill `currency`, `order_total`, and set `reconciled`. Otherwise leave null and let FLOW 5 handle it.
6. Attempt to write `other_text` **only** if the "Other" flow (FLOW 4) was used — it is a separate endpoint so the one-tap path never waits on a text field.

**Exact behaviour per your requirements**

| Scenario | HTTP | Body | Data effect | Buyer sees |
|---|---|---|---|---|
| First submission | 200 | `{status:"recorded"}` | 1 row | "Thanks!" then collapse |
| Double-tap (same page) | — | — | none (client guard) | unchanged |
| Refresh page, tap again | 200 | `{status:"duplicate"}` | **still 1 row** | "Thanks!" then collapse |
| Order status page, same order | 200 | `{status:"duplicate"}` | **still 1 row** | "Thanks!" then collapse |
| Cap reached | 200 | `{status:"locked"}` | 1 row, `is_locked=true` | "Thanks!" then collapse |

**Why `{status:"duplicate"}` is 200 not 409:** App Store requirement 2.1.1 forbids web errors that partially prevent review completion. A duplicate is a *success state*, not a client error. Returning 409 would make the extension's retry logic treat it as a failure.

**Never:** reject a duplicate; surface an error to the buyer; create a second row.

---

## FLOW 4 — "Other (free text)" answer

Only active when the merchant enabled `allow_other`.

1. Buyer picks "Other", a text field appears.
2. On submit, the extension sends `POST /public/responses` with `channel:"other"` **first**, so the primary record exists and is never blocked by text.
3. Then `POST /public/other-response` with `{order_id, text}`.
4. Backend: trim, collapse whitespace, **truncate to 200 chars**, strip control characters and HTML tags. Update `survey_responses.other_text` where `order_id` matches.
5. Free text is stored as-is (not escaped into HTML at rest) and rendered **as text content only** in the admin, never as HTML. This is the XSS boundary.

**Failure modes**

| Condition | Behaviour |
|---|---|
| `POST /public/responses` succeeded, `other-response` failed | Row exists with `other_text=null`. Retry `other-response` (FLOW 12). Buyer already saw "Thanks!". |
| Text >200 chars | Truncate server-side. Never error. |
| Text contains `<script>` | Stripped. Stored plain. |
| Empty text after trim | Set `other_text = null`. Row still exists. |
| `other-response` arrives for unknown order | `404`. Log. Extension stops retrying (not transient). |

---

## FLOW 5 — Response arrives before the `orders/create` webhook

**This is expected, not exceptional.** Shopify documents that on the Thank-you page "the order is not yet created when these extensions are displayed."

1. FLOW 3 inserts the response with `order_total = null`, `currency = null`, `reconciled = false`.
2. The extension returns "Thanks!" normally. **The buyer is never blocked on the webhook.**
3. The dashboard, for this row, shows revenue as **"Pending"** (not $0.00 — that would be a lie).
4. When `orders/create` later arrives (FLOW 7), it upserts `orders_cache` and immediately backfills all `survey_responses` rows for that `order_id` that have `order_total IS NULL`.
5. **Sweep job** (runs every hour, plus once on dashboard load if any pending rows exist): for each `(shop_id, order_id)` where `reconciled = false`, re-check `orders_cache`. Rows older than 24 hours with no matching order are marked `unreconcilable = true` and excluded from revenue totals, with a logged warning. **They are never deleted** — the response data is real and the merchant should see it.

**Race safety:** reconciliation is an `UPDATE ... WHERE order_id = ? AND order_total IS NULL`. Running it twice is a no-op. No locking needed.

---

## FLOW 6 — Webhook retries and out-of-order delivery

**Trigger:** any POST to `/webhooks`.

Shopify states it "doesn't guarantee ordering within a topic, or across different topics for the same resource."

1. **Verify HMAC.** Recompute base64 HMAC-SHA256 of the **raw** body with `SHOPIFY_API_SECRET`. Constant-time compare against `X-Shopify-Hmac-SHA256`. **Mismatch → `401`, no processing, log at `warn`.** Shopify explicitly requires this for compliance webhooks.
2. **Claim the webhook ID.** `INSERT INTO webhook_events (webhook_id, …)`. The unique constraint makes this atomic.
   - Unique violation → this exact delivery was already received. Return `200 {status:"duplicate"}` immediately. **This is what makes retries and duplicate delivery free.**
3. Read `X-Shopify-Topic` and dispatch.

**Out-of-order handling per topic**

| Topic | Guard |
|---|---|
| `orders/create` then `orders/updated` arriving reversed | Both write `orders_cache` with `ON CONFLICT (shop_id, order_id) DO UPDATE … WHERE excluded.updated_at_shop >= orders_cache.updated_at_shop`. Older payloads never overwrite newer state. |
| `orders/cancelled` before `orders/create` | Creates a row with `is_cancelled=true` and whatever total is present. The later `orders/create` fills in the rest. |
| `orders/updated` for an order we never saw | Creates the row. Harmless. |
| Two `orders/create` for the same order | Second is blocked by the unique index. |

4. On success: set `processed_at`. Return `200`.
5. On **transient** failure (DB timeout, `P1001` connection error): return `500` so **Shopify retries**. `webhook_events.processed_at` stays null; on retry, step 2 finds the existing row with `processed_at = null`, and re-processes (an UPDATE, not a fresh INSERT). Set `error` for observability.
6. On **permanent** failure (malformed JSON, unknown topic): return `200` and log. Retrying will never help; returning `500` would cause Shopify to retry forever.

**This is why idempotency is insert-first:** a retry of a webhook that we failed halfway through must be able to redo the work, and a retry of one we fully completed must be free.

---

## FLOW 7 — `orders/create` / `orders/updated` handling

1. Extract from the payload: `id`, `admin_graphql_api_id`, `name`, `currency`, `current_total_price`, `financial_status`, `test`, `cancelled_at`, `created_at`, `updated_at`.
2. Upsert `orders_cache` (guard on `updated_at_shop`, per FLOW 6).
3. **Backfill:** `UPDATE survey_responses SET currency=?, order_total=?, reconciled=true WHERE shop_id=? AND order_id=? AND order_total IS NULL`.
4. **Revenue eligibility** applied at read time, not write time (see FLOW 14). We store raw facts; interpretation lives in one function.

**Failure modes**

| Condition | Behaviour |
|---|---|
| `currency` missing from payload | Use shop's `currency` field. Log. Never store a null currency. |
| Payload lacks `order_id` we're tracking | No-op, `200`. |
| Decimal precision issue | Postgres `Decimal(12,2)`. Reject values with >2 decimal places rather than silently rounding. |
| Webhook body > 1 MB | Body parser limit rejects with `413`. Shopify's order payloads can be large; we only need a handful of fields. Consider `include_fields` filtering to reduce size. |

---

## FLOW 8 — `app/uninstalled`

**Trigger:** merchant uninstalls SourceTrac.

1. Load the shop by domain from the payload.
2. **Immediately** (uninstall-time, not 48h later): delete the encrypted access token and set `access_token_encrypted = null`. We can no longer call the Admin API, so we retain nothing that grants access.
3. Set `install_state = 'uninstalled'`, record `uninstalled_at`.
4. **Retain** `survey_responses` and `orders_cache` for 48 hours, then delete. Rationale: a reinstall within 48 hours restores the merchant's history (common during plan changes, trial resets, and accidental uninstalls). This is a documented product decision, surfaced in the privacy policy.
5. Return `200`.

**Privacy note:** retaining data about a store that uninstalled for up to 48 hours is a processing decision we must disclose. The privacy policy template says so explicitly.

---

## FLOW 9 — Uninstall/reinstall within 48 hours

1. `app/uninstalled` ran: token nulled, data retained, `install_state='uninstalled'`.
2. Merchant reinstalls. OAuth completes. `shopify.server.ts`'s `afterInstall` hook runs.
3. Detect the existing row by `shop_domain`. **Restore, don't create.** Re-encrypt the new access token. Set `install_state='installed'`, clear `uninstalled_at`.
4. All prior `survey_responses` and `orders_cache` rows are still present → dashboard history is intact.
5. Reset `billing_usage` for the current period to 0 **only if** no active paid subscription is found via the Billing API. If a paid subscription is active, restore its usage count from `billing_usage` (untouched by uninstall).

**Failure mode:** reinstall after 48h → the row was deleted in the FLOW 8 purge → a fresh shop row is created, history is empty. Dashboard shows the empty state with a plain explanation, not an error.

---

## FLOW 10 — Session token verification (extension → backend)

Applies to `GET /public/survey-config`, `POST /public/responses`, `POST /public/other-response`.

1. Read `Authorization: Bearer <token>`. Missing → `401 {error:"unauthorized"}` + log at `warn` (with `reason:"missing"`).
2. Decode and verify the JWT **signature** using `SHOPIFY_API_SECRET` as the HMAC key. Invalid signature → `401`, log `reason:"bad_signature"`.
3. **Validate `aud`** equals our app's API key / client ID. Mismatch → `401`, log `reason:"bad_aud"`. This blocks tokens minted for a different app.
4. **Validate `exp`** (5-minute TTL). Expired → `401`, log `reason:"expired"`.
5. **Validate `nbf`** and `iat` are sane (not in the future).
6. **Extract `dest`** → shop domain. This is the **authoritative** shop identity.
7. Optionally use `sub` (customer GID). **We do not store it.** It is absent for anonymous buyers anyway.
8. Check the `jti` nonce is not a replay of a request we already accepted. Session tokens have a 5-minute TTL, so replay within the window is theoretically possible; because responses are idempotent on `(shop_id, order_id)`, a replayed response is harmless by construction.

**Why we don't use a hardcoded secret:** Shopify docs state a session token "only guarantees the integrity of its claims. It does not guarantee the request itself originated from Shopify… your API server could trust the session token's `sub` claim but it could not trust a `?customer_id=` query parameter." So: trust `dest`, `aud`, `exp` — nothing from the request body except the validated fields.

**Never:** trust a shop domain from the body or query string; log the token; accept a token signed with any key other than `SHOPIFY_API_SECRET`.

---

## FLOW 11 — Free cap reached

**Trigger:** Free-plan shop has `responses_count >= 50` for the current UTC month.

1. New responses **are still recorded** with `is_locked = true`. **No data is ever lost.** The buyer always sees "Thanks!".
2. `responses_count` keeps incrementing so the admin shows true volume.
3. Admin UI shows:
   - A persistent banner at **80% of cap** (40/50): "You're using 40 of your 50 free responses this month."
   - After cap: "You've collected more responses than your free plan includes. Your data is safe — upgrade to keep collecting without limits."
   - A "locked responses" row in the dashboard showing count and revenue, so merchants see exactly what they'd gain.
4. The dashboard **still shows and exports locked responses** — we don't hide the merchant's own data to create urgency. The upgrade prompt is informative, not punitive.
5. Cap resets at the first instant of the next UTC month. The banner disappears automatically.

**Rationale for "still collect":** deleting or blocking buyer responses to force an upgrade would violate App Store requirement 1.3 (honest review/pressure practices) in spirit and would make the dashboard lie about conversion. Collecting and flagging is honest.

---

## FLOW 12 — Backend cold start, down, or slow

**Client: the extension.**

1. Request fails (network error, timeout 10s, 5xx, 502, 503, 504).
2. **Keep the answer in memory.** Never discard it.
3. Retry schedule — exponential with full jitter, capped:

   | Attempt | Delay before attempt |
   |---|---|
   | 1 | 0s (immediate) |
   | 2 | 1s ± 30% jitter |
   | 3 | 2s ± 30% |
   | 4 | 4s ± 30% |
   | 5 | 8s ± 30% |
   | 6 | 15s ± 30% |
   | 7 | 15s ± 30% |
   | 8 | 15s ± 30% |

   Total budget ≈ **60 seconds**, 8 attempts.
4. Also retry immediately (no delay) on `429` **only if** a `Retry-After` header says 0.
5. **On first success at any attempt:** show "Thanks!", start the collapse animation. Done.
6. **On final failure (attempt 8):**
   - Log `{event:'survey_submit_failed', order_id, attempts:8, last_status, duration_ms}`.
   - **Hide the survey** (render null). Do not show an error, do not show a retry button, do not block navigation.
   - The page is unaffected. The buyer may never know anything happened, which is the correct outcome for a non-essential widget.

**4xx behaviour:** `401` and `404` are **not retried** — they are permanent. `400` is not retried. Only network errors, timeouts, and 5xx are retried.

**Server: the backend.**

1. **Neon connection errors** (`P1001`, `P1008`, connection timeouts): retry up to 3 times with 200ms/400ms/800ms backoff. Then return `503` with `Retry-After: 5`.
2. **Any unhandled error** → centralised handler logs a structured record with `request_id`, `route`, `status`, and stack, returns a generic JSON error. **No stack traces to clients.**
3. **Shopify Admin API 429** → honour `Retry-After` when present, otherwise exponential backoff, max 3 attempts. GraphQL Admin API's standard limit is 100 points/second with a leaky bucket.
4. **Shopify GraphQL 200-with-`errors`** → treat as failure, log the full errors array. Never silently treat an errored GraphQL response as success.

---

## FLOW 13 — Input validation, sanitization, rate limiting (public endpoints)

**Validation rules (enforced server-side, never trust the client)**

| Field | Rule | Error |
|---|---|---|
| `order_id` | `^gid://shopify/Order/\d+$` | `400 {error:"invalid_order_id", hint:"Order ID must be a Shopify order GID."}` |
| `channel` | Must be in the shop's configured option values, or the literal `other` | `400 {error:"invalid_channel", hint:"Pick one of the answer options."}` |
| `other_text` | Trimmed, whitespace-collapsed, control chars stripped, HTML tags stripped, ≤200 chars | Truncate rather than reject |
| `locale` | `^[a-z]{2}(-[A-Z]{2})?$`, ≤10 chars | Drop silently, log |
| Body size | ≤ 8 KB for `/public/*` | `413` |

**Sanitization**
- No HTML rendering of any buyer-supplied string anywhere. React escapes by default; we never use `dangerouslySetInnerHTML`.
- `other_text` is additionally stripped server-side so the admin export is safe to open in a spreadsheet.
- Log injection: all logged values are JSON-encoded; newlines in user strings are escaped.

**Rate limiting (in-memory token bucket, per shop domain)**

| Endpoint | Bucket | Refill |
|---|---|---|
| `GET /public/survey-config` | 30 tokens | 1/second |
| `POST /public/responses` | **10 tokens** | 1 per 6 seconds |
| `POST /public/other-response` | 10 tokens | 1 per 6 seconds |

`POST /public/responses` gets a tight limit because **one legitimate buyer generates at most 2 requests** (config + response, plus optional other-text). Ten per minute tolerates bursty checkout traffic and blocks scripted abuse.

**In-memory, not Redis.** Acceptable because SourceTrac is single-instance on Render free. If we ever scale out, this must move to a shared store. Documented, not hidden.

**429 response:** `{error:"rate_limited"}` + `Retry-After` in seconds. The extension honours it.

**Also:** CORS preflight `OPTIONS` is answered for all `/public/*` paths with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, GET, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Max-Age: 86400`.

---

## FLOW 14 — Revenue treatment for refunds, cancellations, and test orders

**This is a product decision with no Shopify-mandated answer, so I am defining it explicitly and documenting it in-app.**

A response row's revenue contribution is computed at read time from `orders_cache`:

| Condition | Contributes to revenue? | Shown as |
|---|---|---|
| `is_test = true` | **No.** Excluded from all revenue, AOV, and exports. | Excluded entirely |
| `is_cancelled = true` | **No.** | Excluded from revenue; **shown** in a "cancelled orders" note so the merchant can see why a channel's numbers differ from Shopify's |
| `financial_status = "voided"` | **No.** | Excluded |
| `financial_status = "refunded"` | **No.** Fully refunded = no revenue. | Excluded |
| `financial_status = "partially_refunded"` | **Yes, net.** `current_total_price` is already net of refunds, returns and edits (Shopify), so it is used as-is. Nothing is subtracted from it; `total_refunded` is not a documented order field and is not stored. | Included at `current_total_price` |
| `financial_status = "paid"` or `null` | **Yes.** | Included at `current_total_price` (also reflects order edits) |
| `order_total IS NULL` (webhook never landed) | **No.** | "Pending" badge — explicitly not $0 |
| `unreconcilable = true` | **No.** | "Unmatched" badge |

**Currency rule — absolute.** Revenue is **never summed across currencies.** All aggregation is `GROUP BY currency`. The dashboard displays one revenue block per currency the shop actually has responses in. AOV is computed per currency. CSV includes a `currency` column and is never pre-summed.

There is **no conversion**. Converting would require a rate source, a rate timestamp, and an accuracy claim we cannot make without a data provider. Separation is honest; conversion would not be.

**Empty data and divide-by-zero**

| Metric | Guard |
|---|---|
| AOV | `count === 0 → null`, render as "—" (em dash), never `0`. Never divide. |
| Response rate | `ordersInPeriod === 0 → null`, render "—". Never `NaN`. Never `Infinity`. |
| Revenue | `no rows → 0`, render "$0.00" (this one *is* genuinely zero and reads correctly). |
| Trend line | Fewer than 2 data points → render an explanatory sentence, not a broken chart. |
| Percentage change | Previous period is 0 → render "New", not "∞%". |

---

## FLOW 15 — Timezone boundaries

**Problem:** "this month" for billing usage and "last 7 days" for trends are ambiguous without a rule.

**Rule: all period boundaries are UTC.** Documented in the admin UI next to the date range ("Times shown in UTC").

| Window | Definition |
|---|---|
| Billing period | `period_start` = first instant of the current UTC month (`YYYY-MM-01T00:00:00.000Z`). Resets at `00:00 UTC` on the 1st. |
| 7-day trend | `[now − 7×24h, now]` in UTC. Sliding, not calendar days. |
| 30-day trend | `[now − 30×24h, now]` |
| 90-day trend | `[now − 90×24h, now]` |
| "Today" in admin | UTC day, matching the trend windows so the numbers reconcile. |

**Why UTC and not the shop's timezone:** the merchant's shop timezone is available from the Admin API, but a buyer's response can arrive at any moment and the billing cap must reset at one unambiguous instant globally. A UTC cap boundary is also the only one that can be computed identically in the database and in the dashboard without a second source of truth.

**Shop timezone** is stored and used **only** for display formatting of individual timestamps in the response table, clearly labelled with the zone. It never affects aggregation.

**Day boundaries in SQL:** all range queries use half-open intervals `[start, end)` so an instant exactly at midnight belongs to exactly one bucket. No duplicate-counting, no dropped rows.

---

## FLOW 16 — GDPR / compliance webhooks

`customers/data_request`, `customers/redact`, `shop/redact`. All three are mandatory for any App Store app.

**Common preamble:** verify HMAC (invalid → `401`, per Shopify's explicit requirement). Claim the webhook ID for idempotency (FLOW 6). Respond `200` **within Shopify's timeout budget** — the actual work happens after responding where possible.

### `customers/data_request`
1. Respond `200`.
2. Payload contains `customer.id`, `customer.email`, `customer.phone`, `orders_requested[]`, `data_request.id`.
3. **Our honest answer: we hold no customer-profile data.** We never store name, email, or phone. Log the request with the `data_request.id` so the merchant can see SourceTrac acknowledged it.
4. We **do** hold order-linked responses for `orders_requested`. We do not export them to anyone — the merchant can already see their own orders in Shopify. We record that the request was received and fulfilled.
5. If the merchant later needs a per-customer export, our data has no customer key, so there is nothing to export by customer. This is the direct benefit of the `read_orders`-only design.

### `customers/redact`
1. Respond `200`.
2. `orders_to_redact[]` → `DELETE FROM survey_responses WHERE shop_id=? AND order_id IN (...)` and the same for `orders_cache`.
3. Record the redaction in an audit log (shop, count, timestamp, `data_request` id if present). **The audit log holds no customer data.**
4. Shopify may withhold this webhook for 6 months if the customer ordered recently. We do nothing special; when it arrives we comply.
5. **Data we legally cannot delete:** nothing. We hold no data with a legal-retention obligation, so full deletion is always possible. This is by design.

### `shop/redact`
1. Arrives **48 hours after uninstall**.
2. Respond `200`.
3. **Hard delete** the shop row and, by cascade, every `survey_responses`, `orders_cache`, `billing_usage` row for that shop. `webhook_events` rows for that shop are deleted.
4. Log the deletion with `shop_id`, `shop_domain`, and timestamp. The log line itself contains no customer data.
5. The encrypted access token was already nulled at `app/uninstalled` (FLOW 8). If for any reason a token still exists, it is overwritten with `null` before the row is removed.

**Retention job** runs daily at 03:00 UTC:
- `webhook_events` older than 30 days → delete.
- `survey_responses` / `orders_cache` older than 24 months → delete.
- Shops `install_state='uninstalled'` for more than 48 hours → cascade delete.

---

## FLOW 17 — Database errors, 429s, Shopify throttling

**Classification of every error we can hit**

| Source | Condition | Retry? |
|---|---|---|
| Postgres | `P1001` can't reach server, `P1008` timeout, `P2024` pool timeout | Yes, 3× (200/400/800ms) |
| Postgres | `P2002` unique violation | **No** — this is FLOW 3/6's success path |
| Postgres | `P2003` FK violation | No — log, return 500 (indicates a bug) |
| Postgres | `P2034` write conflict / deadlock | Yes, 2× |
| Postgres | Disk full / connection refused (Neon asleep) | Yes, 3× with 1s/2s/4s |
| Admin GraphQL | HTTP 429 | Yes. Honour `Retry-After`; else exponential 1s/2s/4s. Max 3 |
| Admin GraphQL | HTTP 5xx | Yes, 2× |
| Admin GraphQL | HTTP 200 with `errors[]` | Log full errors. **Do not treat as success.** Retry only if the error is transient (THROTTLED, INTERNAL_SERVER_ERROR) |
| Admin GraphQL | `extensions.cost.throttleStatus` `currentlyAvailable = 0` | Back off until `nextAvailable` |
| Billing API | `userErrors[]` non-empty | No. Surface the message to the merchant verbatim in a toast |
| Partner API (if ever used) | 429 | Yes. Limit is 4 req/s |

**Centralised error handling.** One `AppError` class hierarchy: `ValidationError` (400), `AuthError` (401), `NotFoundError` (404), `RateLimitError` (429), `UpstreamError` (502/503), `InternalError` (500). A single Express error middleware serialises them, logs once with a `request_id`, and returns a safe body. **No swallowed exceptions anywhere** — every `catch` either handles, re-throws, or logs with structured context and a defined fallback.

**Structured logging.** Every log line is one JSON object:

```json
{"ts":"2026-10-01T12:00:00.000Z","level":"info","event":"response_recorded",
 "request_id":"r_abc123","shop_domain":"acme.myshopify.com","order_id":"gid://shopify/Order/1",
 "channel":"instagram","status":"recorded","duration_ms":42}
```

Never log: access tokens, session tokens, JWTs, customer email/phone, `other_text` at info level, or full webhook payloads at info level (only `webhook_id` + `topic`).

---

## FLOW 18 — Errors in the admin UI

| Situation | Design |
|---|---|
| Loader throws | Route `ErrorBoundary` renders a designed error state: plain-language title ("We couldn't load your dashboard"), what happened, one primary action ("Try again"), and a support link. **Never a raw stack trace or a bare "500".** |
| Loader slow | `s-skeleton` placeholders matching final layout, so nothing shifts on load. |
| No data yet | Purpose-written empty state with the single next action ("Place a test order to see your first response") and a deep link to the checkout editor. |
| Starter plan | Full-screen explanatory state: what SourceTrac does, why it can't run (Shopify Starter doesn't support Thank-you/Order-status extensions), and a link to Shopify's plan page. Non-dismissable, because the app genuinely cannot function. |
| Free cap reached | `UpgradeBanner` at 80% and past cap. Informative, includes the count of locked responses. |
| Action fails | Toast with the server's plain-language message. Never a generic "Something went wrong" when we have a specific `hint`. |

---

## FLOW 19 — Plans, limits, and upgrade flow

| Plan | Price | Cap |
|---|---|---|
| Free | $0 | 50 responses / month |
| Growth | $19/mo | unlimited |
| Scale | $49/mo | unlimited |

Implemented with the **Shopify Billing API** (`appSubscriptionCreate`), which is still supported and satisfies App Store requirement 1.2.1.

1. Merchant clicks the plan → loader calls `appSubscriptionCreate` with `replacementBehavior: STANDARD` and our `returnUrl`.
2. Redirect merchant to the returned `confirmationUrl` (Shopify-hosted approval page).
3. On approval, Shopify redirects to `returnUrl?charge_id={id}`.
4. Loader queries `currentAppInstallation { activeSubscriptions { id name status } }` to confirm. **We never trust the query parameter alone** — we verify server-side.
5. Update `shops.plan`, `shops.plan_status`, `shops.subscription_gid`.
6. Reset `billing_usage.cap` to the new plan's cap.
7. Merchant can upgrade or downgrade without contacting us or reinstalling (requirement 1.2.3). Downgrades take effect at the end of the current cycle via `replacementBehavior: APPLY_ON_NEXT_BILLING_CYCLE`.

**Failure modes**

| Condition | Behaviour |
|---|---|
| Merchant declines the charge | Shopify redirects to admin with a notice. Our loader finds no active subscription → Plans page shows current (unchanged) plan with a toast: "Your plan wasn't changed." |
| `userErrors` on create | Show the message verbatim in a toast. Do not redirect. |
| Subscription `FROZEN` (merchant's store billing issue) | Treat as **unpaid**. Response collection **continues** (never lose buyer data). Dashboard shows a banner: "Your SourceTrac plan needs attention — payments are paused." |
| Subscription `CANCELLED` | Revert to Free behaviour with the 50 cap. Banner explains, one click to resubscribe. |
| Subscription `EXPIRED` (declined on renewal) | Same as cancelled. |
| Webhook `APP_SUBSCRIPTIONS_UPDATE` | Updates `plan_status`. **Note:** per finding A12, Shopify App Pricing stopped sending these webhooks in April 2026; the Billing API path still does. If we migrate to App Pricing, this becomes a Partner API query instead. |

**Upgrade banner at 80%:** shown when `responses_count >= ceil(cap * 0.8)` → 40/50 on Free. One primary action: "See plans".

---

## FLOW 20 — Onboarding checklist status detection

Three steps, each with a live status check:

| Step | How status is detected | Deep link |
|---|---|---|
| 1. Enable the survey in the checkout editor | Query `Shopify.appInstallation` extension status via the Admin API for our extension UUID. If status is active → done. | `admin.shopify.com/store/{shop}/checkout/customization` |
| 2. Pick your channels | `shops.options_json.length >= 6 && question_text.length > 0` → done | Internal → Settings |
| 3. See your first response | `survey_responses.count > 0` → done | Internal → Dashboard |

**Status states per step:** `done` (check), `todo`, and `blocked` (shown only for step 1 when the shop is Starter — "You can't do this on your current plan").

**Deep links.** Step 1 opens the checkout editor so the merchant can place the SourceTrac block. Because block targets are merchant-placed, **the survey does not appear until they place it** — this is why step 1 exists and why its status is checked rather than assumed.

---

## Summary of "never" rules

The app must **never**:

1. Block or visually break the Thank-you or Order status page.
2. Lose a buyer's response.
3. Reject a duplicate submission with an error.
4. Store customer name, email, phone, or address.
5. Sum revenue across currencies.
6. Render buyer-supplied text as HTML.
7. Trust a shop identity from anywhere except the session token's `dest` claim.
8. Swallow an exception without logging it with context.
9. Show a stack trace or raw error to a buyer or merchant.
10. Block response collection because a merchant is on Free, unpaid, or cancelled — it collects and flags.
11. Require the uptime pinger to function.
</content>