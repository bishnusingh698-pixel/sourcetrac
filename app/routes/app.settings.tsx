import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { LanguageForm } from "~/components/language-selector";
import { db } from "~/db.server";
import { isSupportedLanguage } from "~/lib/i18n";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { RECORD_RETENTION_DAYS, WEBHOOK_RETENTION_DAYS } from "~/lib/retention.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { FEATURE_FLAGS } from "@shared/feature-flags";
import { countFailedSync } from "~/lib/sync.server";
import { grantedSyncScopes } from "~/lib/scopes.server";

/**
 * Settings — store-level options.
 *
 * This page used to hold the single survey's question and options. Those now
 * live in the survey editor (`/app/surveys`), so this page keeps the settings
 * that are not tied to one survey: language, data retention, Shopify sync
 * status, and privacy.
 *
 * `/app/settings` is kept as a route so bookmarks and the sidebar link keep
 * working after the editor move.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "settings.title");

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const [surveyCount, responseCount, dataRequests, failedSync] = await Promise.all([
    db.survey.count({ where: { shopId: shop.id } }),
    db.response.count({ where: { shopId: shop.id } }),
    db.dataRequest.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, createdAt: true },
    }),
    // Shopify writes that gave up after every retry, so they are not silent.
    countFailedSync(shop.id),
  ]);

  return {
    language: isSupportedLanguage(shop.language) ? shop.language : null,
    retention: {
      recordsMonths: Math.round(RECORD_RETENTION_DAYS / 30),
      webhookDays: WEBHOOK_RETENTION_DAYS,
    },
    counts: { surveys: surveyCount, responses: responseCount },
    // Which Phase 7 scopes the merchant granted. Sync features are gated on
    // this, so a store that has not re-approved keeps working unchanged.
    grantedScopes: grantedSyncScopes(session.scope),
    bonusFlagsOn: FEATURE_FLAGS.ONSITE_SURVEYS || FEATURE_FLAGS.SURVEY_LINK_PAGE,
    failedSync,
    dataRequests: dataRequests.map((request) => ({
      id: request.id,
      createdAt: request.createdAt.toISOString(),
    })),
  };
});

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const { t, language } = useAdminI18n();

  return (
    <s-stack gap="base">
      <s-section heading={t("settings.title")} subheading={t("settings.subtitle")} padding="none" />

      <Banner tone="info" heading={t("settings.survey_moved_title")}>
        <s-stack gap="small">
          <s-text>{t("settings.survey_moved_body")}</s-text>
          <div>
            <s-button href="/app/surveys" variant="primary">
              {t("settings.survey_moved_cta")}
            </s-button>
          </div>
        </s-stack>
      </Banner>

      <Panel title={t("settings.language_title")} description={t("settings.language_description")}>
        <LanguageForm language={data.language ?? language} />
      </Panel>

      <Panel title={t("settings.retention_title")} description={t("settings.retention_description")}>
        <s-stack gap="small">
          <s-text>{t("settings.retention_records", { months: data.retention.recordsMonths })}</s-text>
          <s-text>{t("settings.retention_webhooks", { days: data.retention.webhookDays })}</s-text>
          <s-text color="subdued" fontSize="small">
            {t("settings.retention_counts", { surveys: data.counts.surveys, responses: data.counts.responses })}
          </s-text>
        </s-stack>
      </Panel>

      <Panel title={t("settings.sync_title")} description={t("settings.sync_description")}>
        <s-stack gap="small">
          <s-text>{data.grantedScopes.length > 0 ? t("settings.sync_granted") : t("settings.sync_not_granted")}</s-text>
          <s-text color="subdued" fontSize="small">
            {t("settings.sync_gated_note")}
          </s-text>
          {data.failedSync.count > 0 ? (
            <s-text tone="critical">
              {t("settings.sync_failed", { count: data.failedSync.count, error: data.failedSync.lastError ?? "—" })}
            </s-text>
          ) : null}
          {data.bonusFlagsOn ? (
            <s-text color="subdued" fontSize="small">
              {t("settings.sync_flags_on")}
            </s-text>
          ) : null}
        </s-stack>
      </Panel>

      <Panel title={t("settings.privacy_title")} description={t("settings.privacy_description")}>
        <s-stack gap="small">
          <s-text>{t("settings.privacy_body")}</s-text>
          {data.dataRequests.length > 0 ? (
            <s-stack gap="small-200">
              <s-text type="strong">{t("settings.privacy_requests_title")}</s-text>
              {data.dataRequests.map((request) => (
                <s-text key={request.id} fontSize="small">
                  {request.createdAt.slice(0, 10)}
                </s-text>
              ))}
            </s-stack>
          ) : null}
        </s-stack>
      </Panel>
    </s-stack>
  );
}
