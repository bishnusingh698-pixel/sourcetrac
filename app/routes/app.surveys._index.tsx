import { Form, redirect, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { useState } from "react";

import { Panel, type BadgeTone, PageIntro } from "~/components/admin-ui";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import {
  deleteSurvey,
  duplicateSurvey,
  listSurveys,
  liveSurveyUsage,
  reorderSurveys,
  setSurveyStatus,
  type SurveyListItem,
} from "~/lib/surveys.server";
import { formatDay } from "~/lib/format-day";
import { getBlockSeen, markBlockAdded } from "~/lib/block-seen.server";
import { BlockMissingBanner, postedPlacements } from "~/components/block-missing";
import { placementsMissingBlock } from "~/lib/checkout-editor";
import { NotFoundError, ValidationError } from "~/lib/errors";
import { RecentCheckouts, type RecentCheckoutRow } from "~/components/recent-checkouts";
import { CheckoutCheck, type CheckoutCheckView } from "~/components/checkout-check";
import { runCheckoutCheck } from "~/lib/checkout-check.server";
import { recentServes } from "~/lib/serve-log.server";
import { getShopLocaleInfo } from "~/lib/studio.server";
import { resolveAdminLanguage, resolveFormatLocale } from "~/lib/i18n/resolve.server";
import { isValidTimeZone } from "@shared/zoned-date";
import { db } from "~/db.server";

/**
 * Surveys list.
 *
 * Every new survey starts on the template page, which also offers a blank
 * survey, so this page has one way in. Row actions cover Edit, Duplicate,
 * Pause/Activate and Delete. Priority is edited with up/down controls rather than drag, which
 * is keyboard-accessible for free.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "surveys.title");

export const handle = { titleKey: "surveys.title" };

function statusTone(status: SurveyListItem["status"]): BadgeTone {
  if (status === "active") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const [surveys, usage, blockSeen, localeInfo] = await Promise.all([
    listSurveys(shop.id),
    liveSurveyUsage(shop.id),
    getBlockSeen(shop.id),
    getShopLocaleInfo(shop.id, shop.shopDomain, session.accessToken),
  ]);
  // Times read in the store's own zone and the merchant's language.
  const format = new Intl.DateTimeFormat(resolveFormatLocale(request, resolveAdminLanguage(request, shop.language, shop.adminLocale), shop.adminLocale), {
    timeZone: isValidTimeZone(localeInfo.timeZone) ? localeInfo.timeZone : "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const surveyNames = new Map(surveys.map((s) => [s.id, s.name]));
  const [recent, check] = await Promise.all([
    recentCheckoutRows(shop.id, surveyNames, format),
    runCheckoutCheck(shop.id, surveyNames),
  ]);
  const checkView: CheckoutCheckView = {
    pages: check.pages.map((page) => ({
      placement: page.placement,
      survey: page.survey,
      block: page.block.kind === "never" ? page.block : { kind: page.block.kind, when: format.format(new Date(page.block.at)) },
    })),
    planHidden: check.planHidden,
  };

  // Pages a live survey is set to show on where the block has never loaded.
  const missing = [
    ...new Set(surveys.filter((s) => s.status === "active").flatMap((s) => placementsMissingBlock(s.placements, blockSeen))),
  ];

  return {
    surveys,
    usage,
    missing,
    recent,
    check: checkView,
    shopHandle: shop.shopDomain.replace(".myshopify.com", ""),
  };
});

/** The last checkout page decisions, with order and survey names filled in. */
async function recentCheckoutRows(
  shopId: string,
  surveyNames: ReadonlyMap<string, string>,
  format: Intl.DateTimeFormat,
): Promise<RecentCheckoutRow[]> {
  const entries = await recentServes(shopId);
  if (entries.length === 0) return [];
  const orderIds = [...new Set(entries.map((e) => e.orderId).filter((id): id is string => Boolean(id)))];
  const orders = orderIds.length
    ? await db.orderCache.findMany({ where: { shopId, orderId: { in: orderIds } }, select: { orderId: true, orderNumber: true } })
    : [];
  const names = new Map(orders.map((o) => [o.orderId, o.orderNumber]));
  return entries.map((entry) => ({
    at: entry.at,
    when: format.format(new Date(entry.at)),
    placement: entry.placement,
    // The order's name (#1001) once its webhook landed; its id until then.
    order: entry.orderId ? (names.get(entry.orderId) ?? entry.orderId) : null,
    surveyName: entry.surveyId ? (surveyNames.get(entry.surveyId) ?? null) : null,
    reason: entry.reason,
    country: entry.country,
  }));
}

export const action = guarded(async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const surveyId = String(form.get("surveyId") ?? "");

  // Expected refusals (a limit, a missing placement, a survey deleted in another
  // tab) are shown on the page, not turned into the generic 500 screen.
  try {
    return await runListAction(shop.id, intent, surveyId, form);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      const code = typeof error.fields.code === "string" ? error.fields.code : error.code;
      return { ok: false as const, code, message: error.message };
    }
    throw error;
  }
});

async function runListAction(shopId: string, intent: string, surveyId: string, form: FormData) {
  const shop = { id: shopId };
  switch (intent) {
    case "duplicate": {
      const survey = await duplicateSurvey(shop.id, surveyId);
      return redirect(`/app/surveys/${survey.id}`);
    }

    case "pause":
      await setSurveyStatus(shop.id, surveyId, "paused");
      return { ok: true as const };

    case "activate":
      await setSurveyStatus(shop.id, surveyId, "active");
      return { ok: true as const };

    case "block-added":
      await markBlockAdded(shop.id, postedPlacements(form));
      return { ok: true as const };

    case "delete":
      await deleteSurvey(shop.id, surveyId);
      return { ok: true as const };

    case "reorder": {
      const ids = String(form.get("orderedIds") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length > 0) await reorderSurveys(shop.id, ids);
      return { ok: true as const };
    }

    default:
      throw new ValidationError("Unknown action.", "Reload the page and try again.");
  }
}

function StatusBadge({ status }: { status: SurveyListItem["status"] }) {
  const { t } = useAdminI18n();
  return <s-badge tone={statusTone(status)}>{t(`surveys.status_${status}`)}</s-badge>;
}

export default function Surveys() {
  const { surveys, usage, missing, recent, check, shopHandle } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { t, locale } = useAdminI18n();
  const failureKey = actionData && actionData.ok === false ? `surveys.validation_${actionData.code}` : null;
  // `limit` fills `validation_plan_live_limit`; without it the banner read
  // "Your plan allows {{limit}} live surveys".
  const failureParams = { limit: usage.limit ?? "" };
  const failureText = failureKey
    ? t(failureKey) === failureKey
      ? actionData!.ok === false && actionData!.message
      : t(failureKey, failureParams)
    : null;

  const createActions = (
    <>
      <s-button href="/app/surveys/quick-start" icon="wand">
        {t("quick.cta")}
      </s-button>
      <s-button href="/app/surveys/library" variant="primary" icon="plus">
        {t("surveys.new_survey")}
      </s-button>
    </>
  );

  return (
    <s-stack gap="base">
      <PageIntro actions={createActions}>{t("surveys.subtitle")}</PageIntro>
      {failureText ? <s-banner tone="critical">{failureText}</s-banner> : null}
      {missing.length > 0 ? (
        // "Live" here means turned on. Buyers only see it once the block is in
        // the checkout, which the app can only tell from the block loading.
        <BlockMissingBanner missing={missing} shopHandle={shopHandle} t={t} />
      ) : null}
      {usage.limit !== null && usage.live > usage.limit ? (
        // A downgrade leaves more surveys live than the plan serves. Buyers only
        // see the first ones in priority order; the rest keep their settings.
        <s-banner tone="warning" heading={t("surveys.over_limit_title", { count: usage.limit })}>
          <s-stack gap="small">
            <s-text>{t("surveys.over_limit_body", { count: usage.limit })}</s-text>
            <s-stack direction="inline" gap="small">
              <s-button href="/app/plans">{t("surveys.see_plans")}</s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      ) : null}

      {surveys.length === 0 ? (
        <Panel title={t("surveys.empty_title")} description={t("surveys.empty_body")}>
          <s-stack direction="inline" gap="small">{createActions}</s-stack>
        </Panel>
      ) : (
        <s-section>
          <s-stack gap="base">
            {surveys.length > 1 ? (
              <s-text color="subdued" fontSize="small">
                {t("surveys.priority_help")}
              </s-text>
            ) : null}

            {/* One card per survey instead of a six-column table: on a phone
                the table squeezed every column, and the row of seven buttons
                ran off the edge. The card leads with what a merchant scans for
                (name, status, answers) and keeps the actions on their own row. */}
            {surveys.map((survey, index) => (
              <s-box key={survey.id} padding="base" border="base" borderRadius="large">
                <s-stack gap="base">
                  <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="base" alignItems="start">
                    <s-stack gap="small-200">
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-link href={`/app/surveys/${survey.id}`}>
                          <s-text type="strong">{survey.name}</s-text>
                        </s-link>
                        <StatusBadge status={survey.status} />
                      </s-stack>
                      <s-text color="subdued" fontSize="small">
                        {survey.placements.length > 0
                          ? survey.placements.map((p) => t(`surveys.placement_${p}`)).join(", ")
                          : t("surveys.placement_none")}
                        {" · "}
                        {t("surveys.updated_on", { date: formatDay(survey.updatedAt, locale) })}
                      </s-text>
                    </s-stack>
                    <s-stack gap="small-200" alignItems="end">
                      <s-text fontWeight="bold" fontVariantNumeric="tabular-nums">
                        {survey.responseCount}
                      </s-text>
                      <s-text color="subdued" fontSize="small">
                        {t("surveys.col_responses")}
                      </s-text>
                    </s-stack>
                  </s-grid>

                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-button href={`/app/surveys/${survey.id}`} icon="edit">
                      {t("common.edit")}
                    </s-button>
                    <s-button href={`/app/results?survey=${survey.id}`} variant="tertiary" icon="chart-vertical">
                      {t("surveys.view_results")}
                    </s-button>
                    {survey.status === "active" ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="pause" />
                        <input type="hidden" name="surveyId" value={survey.id} />
                        <s-button type="submit" variant="tertiary" icon="pause-circle">
                          {t("surveys.pause")}
                        </s-button>
                      </Form>
                    ) : (
                      <Form method="post">
                        <input type="hidden" name="intent" value="activate" />
                        <input type="hidden" name="surveyId" value={survey.id} />
                        <s-button type="submit" variant="tertiary" icon="play-circle">
                          {t("surveys.activate")}
                        </s-button>
                      </Form>
                    )}
                    <Form method="post">
                      <input type="hidden" name="intent" value="duplicate" />
                      <input type="hidden" name="surveyId" value={survey.id} />
                      <s-button type="submit" variant="tertiary" icon="duplicate">
                        {t("surveys.duplicate")}
                      </s-button>
                    </Form>
                    {surveys.length > 1 ? (
                      <>
                        <Form method="post">
                          <input type="hidden" name="intent" value="reorder" />
                          <input
                            type="hidden"
                            name="orderedIds"
                            value={move(surveys, index, index - 1).map((s) => s.id).join(",")}
                          />
                          <s-button
                            type="submit"
                            variant="tertiary"
                            icon="arrow-up"
                            disabled={index === 0 || undefined}
                            accessibilityLabel={t("surveys.move_up")}
                          />
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="reorder" />
                          <input
                            type="hidden"
                            name="orderedIds"
                            value={move(surveys, index, index + 1).map((s) => s.id).join(",")}
                          />
                          <s-button
                            type="submit"
                            variant="tertiary"
                            icon="arrow-down"
                            disabled={index === surveys.length - 1 || undefined}
                            accessibilityLabel={t("surveys.move_down")}
                          />
                        </Form>
                      </>
                    ) : null}
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="surveyId" value={survey.id} />
                      <ConfirmDelete t={t} name={survey.name} />
                    </Form>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {/* Whether buyers can see a survey, and why the last checkouts did or
          did not show one. Shown once the merchant has a survey to check. */}
      {surveys.length > 0 ? <CheckoutCheck check={check} shopHandle={shopHandle} t={t} /> : null}
      {surveys.length > 0 ? <RecentCheckouts rows={recent} t={t} /> : null}
    </s-stack>
  );
}

/** Return a copy of `list` with the item at `from` moved to `to`. */
function move(list: SurveyListItem[], from: number, to: number): SurveyListItem[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item) next.splice(to, 0, item);
  return next;
}

/**
 * Two-step delete. The first tap reveals the consequence and a confirm button;
 * nothing posts until the merchant confirms, and "Cancel" is the default action.
 */
function ConfirmDelete({ t, name }: { t: ReturnType<typeof useAdminI18n>["t"]; name: string }) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <s-button type="button" variant="tertiary" tone="critical" icon="delete" onClick={() => setAsking(true)}>
        {t("surveys.delete")}
      </s-button>
    );
  }

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-text color="subdued" fontSize="small">
        {t("surveys.delete_confirm", { name })}
      </s-text>
      <s-button type="button" onClick={() => setAsking(false)}>
        {t("common.cancel")}
      </s-button>
      <s-button type="submit" tone="critical">
        {t("surveys.delete")}
      </s-button>
    </s-stack>
  );
}
