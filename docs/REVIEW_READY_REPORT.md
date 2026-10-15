# Reviewer-ready review — SourceTrac

Work done to make the app ready for Shopify App Store review, and to add an
email support button. Short and factual; each item names the file and the test.

Date: 2026-10-13

---

## 1. What changed

| Area | Change | Files |
|---|---|---|
| Support email | One constant, `sourcetracsupport@gmail.com`, in `shared/support.ts`. The old placeholder (`support@example.com`) and the second address (`privacy@sourcetrac.app`) are gone. | `shared/support.ts`, `app/routes/privacy.tsx`, `app/routes/app.help.tsx` |
| Email support button | Icon button in the page header of every admin page, a labelled panel on Help, and a link on both error screens. | `app/components/support-button.tsx`, `app/routes/app.tsx`, `app/routes/app.help.tsx`, `app/root.tsx` |
| Prefilled mail body | Shop, plan, app version and current page are prefilled so a support request arrives with context. | `shared/support.ts` → `buildSupportMailto`, `app/routes/app.tsx` loader |
| Translations | New `support.*` keys in all ten locales. | `app/lib/i18n/locales/*.json` |
| Privacy policy | Rewritten to match what the app actually stores (country, buyer language, customer ID for returning-buyer surveys; retention periods; uninstall window). | `app/routes/privacy.tsx` |
| Config | `SUPPORT_EMAIL` env var marked deprecated and ignored; removed from `.env.example`. | `app/lib/env.ts`, `.env.example`, `docs/04-file-tree.md` |

## 2. Requirements checked

| Requirement | Status | Evidence |
|---|---|---|
| Compliance webhooks subscribed (`customers/data_request`, `customers/redact`, `shop/redact`) | Met | `shopify.app.toml` `compliance_topics`; handlers in `app/lib/compliance.server.ts` |
| Privacy policy reachable, no auth | Met | `app/routes/privacy.tsx` (server-rendered, no DB read) |
| A support contact in the app | Met | header button + Help panel; `tests/unit/support.test.ts` |
| No placeholder emails in the app | Met | email-scan test in `tests/unit/support.test.ts` |
| Billing via the Billing API (Shopify App Pricing is retired) | Met | `app/lib/billing.server.ts`; webhook `app_subscriptions/update` |
| Protected customer data Level 1 (no names/emails/phones/addresses) | Met | `docs/05-compliance-and-data-handling.md`; `docs/07-gdpr-and-badge.md` |
| Access scopes justified in the listing | Met | `docs/07-deploy-and-submission.md` §5 |
| API version current | Met | `2026-07` in `shopify.app.toml`, `SHOPIFY_API_VERSION`, and every `shopify.extension.toml` |

**Not verified here** (needs a live Partner Dashboard): the API contact email and
listing email must not contain the word "Shopify"; the app icon must be 1200×1200
JPEG/PNG; screenshots and category are set in the listing form.

## 3. Verification

- `npm run check` — typecheck, extension typecheck, extension config check, build-deps check, full test suite.
- Result on 2026-10-13: **63 test files, 863 tests, all passing** (includes 10 new support tests).
- `npm run build` succeeds; `build/client` is 1.6 MB.

## 4. Founder actions before submitting

1. Confirm `sourcetracsupport@gmail.com` is a real, monitored inbox.
2. In the Partner Dashboard, set the **API contact email** and **listing support
   email** to that address, and make sure neither contains "Shopify".
3. Set the **privacy policy URL** to `<APP_URL>/privacy`.
4. Add a 1200×1200 app icon and capture screenshots on a development store.
5. Remove `SUPPORT_EMAIL` from the Render environment if it is set (it is ignored).
