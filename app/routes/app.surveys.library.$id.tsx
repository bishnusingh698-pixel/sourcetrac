import {
  Form,
  redirect,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { SurveyPreview } from "~/components/survey-preview";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { definitionToPreview } from "~/lib/preview-model";
import { NotFoundError, ValidationError } from "~/lib/errors";
import { isEnabled } from "@shared/feature-flags";
import { catalogDetail, catalogCards, catalogPlanFromKey, templatePlacements, type CatalogPlan } from "@shared/templates/catalog";
import { buildSurveyDefinition } from "@shared/templates/resolve";
import { regionPackFor } from "@shared/templates/packs";
import type { Placement } from "@shared/survey-config";
import { templateById } from "@shared/templates";
import { effectivePlan } from "~/lib/plans";
import { fetchShopLocaleInfo } from "~/lib/shopify-graphql.server";
import { LANGUAGES } from "~/lib/i18n";

/**
 * Template detail (T2).
 *
 * Two columns on desktop: content left, live preview right (sticky). The preview
 * is the same `SurveyPreview` component the Studio uses, so a merchant sees the
 * real survey, not a screenshot. The action creates an independent copy of the
 * template as a draft survey.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "library.title");

export const loader = guarded(async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";

  const { countryCode } = await fetchShopLocaleInfo(shop.shopDomain, session.accessToken);
  const locale = shop.language ?? "en";
  const detail = catalogDetail({
    id,
    locale,
    plan: catalogPlanFromKey(effectivePlan(shop)),
    country: countryCode,
    surveyLinkEnabled: isEnabled("SURVEY_LINK_PAGE"),
  });
  if (!detail) throw new NotFoundError("That template does not exist.", { templateId: id });

  // A definition for the preview, in the merchant's language and region.
  const template = templateById(id)!;
  const definition = buildSurveyDefinition({
    template,
    locale,
    region: regionPackFor(countryCode),
    toggles: defaultToggles(template.questions),
  });
  const preview = definitionToPreview(definition, {
    templateId: template.id,
    templateVersion: template.version,
    placements: templatePlacements(template),
    design: template.defaults.design,
  });

  const questionTypeLabel = (type: string) => `surveys.type_${shortType(type)}`;

  return {
    detail,
    preview,
    languages: LANGUAGES.map((l) => ({ code: l.code, name: l.nativeName })),
    questionTypeLabel,
  };
});

function shortType(type: string): string {
  switch (type) {
    case "single_choice": return "single";
    case "multi_choice": return "multi";
    case "dropdown": return "dropdown";
    case "yes_no": return "yesno";
    case "rating_5": return "rating";
    case "satisfaction_5": return "satisfaction";
    case "nps": return "nps";
    default: return "text";
  }
}

function defaultToggles(questions: { key?: string; required: boolean; optionalInSetup?: boolean }[]): Record<string, boolean> {
  const toggles: Record<string, boolean> = {};
  for (const q of questions) {
    if (!q.required && q.optionalInSetup && q.key) toggles[q.key] = true;
  }
  return toggles;
}

export const action = guarded(async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await ensureShop(session);
  const id = params.id ?? "";
  const form = await request.formData();
  const lite = form.get("lite") === "1";

  const template = templateById(id);
  if (!template) throw new ValidationError("That template does not exist.", "Pick another template.");

  // Quick setup (T3) owns the customization and final Go live / Save as draft.
  // Carrying the Lite flag lets step 1 restrict optional questions to the Free
  // subset without changing the template itself.
  return redirect(`/app/surveys/library/${template.id}/setup${lite ? "?lite=1" : ""}`);
});

export default function TemplateDetail() {
  const { detail, preview, languages } = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();

  const liteExtra = detail.questions.length - detail.liteQuestionCount;

  return (
    <s-stack gap="base">
      <s-link href="/app/surveys/library">{t("library.back")}</s-link>

      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 900px) minmax(0, 1fr) minmax(0, 1fr), 1fr"
          gap="base"
        >
          <s-stack gap="base">
            <s-stack gap="small">
              <s-heading>{detail.name}</s-heading>
              <s-stack direction="inline" gap="small">
                {detail.tags.map((tag) => (
                  <span key={tag.id} title={tag.tip}>
                    <s-badge tone="success">{tag.text}</s-badge>
                  </span>
                ))}
              </s-stack>
              <s-text color="subdued">
                {t("library.meta", { count: detail.questions.length, seconds: detail.questions.length * 8 })}
              </s-text>
              <s-text>{detail.oneLiner}</s-text>
            </s-stack>

            <Panel title={t("library.what_learn")}>
              <s-unordered-list>
                {detail.learn.map((line, i) => (
                  <s-list-item key={i}>{line}</s-list-item>
                ))}
              </s-unordered-list>
            </Panel>

            <Panel title={t("library.questions")}>
              <s-stack gap="small">
                {detail.questions.map((q, i) => (
                  <s-box key={q.key} padding="small" border="base" borderRadius="base">
                    <s-stack gap="small">
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-text type="strong">{`${i + 1}. ${q.text}`}</s-text>
                        <s-badge tone="neutral">{t(`surveys.type_${shortType(q.type)}`)}</s-badge>
                        <s-badge tone="neutral">{q.required ? t("library.required") : t("library.optional")}</s-badge>
                      </s-stack>
                      {q.showIfParentKey ? (
                        <s-text color="subdued" fontSize="small">
                          {t("library.only_if", { option: q.showIfOptionKeys.join(", ") })}
                        </s-text>
                      ) : null}
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            </Panel>

            {detail.ideas.length > 0 ? (
              <Panel title={t("library.ideas")}>
                <s-stack gap="small">
                  {detail.ideas.map((idea) => (
                    <s-text key={idea.id}>{idea.text}</s-text>
                  ))}
                </s-stack>
              </Panel>
            ) : null}

            {detail.goodToKnow.length > 0 ? (
              <Banner tone="info" heading={t("library.good_to_know")}>
                <s-stack gap="small">
                  {detail.goodToKnow.map((line, i) => (
                    <s-text key={i}>{line}</s-text>
                  ))}
                </s-stack>
              </Banner>
            ) : null}
          </s-stack>

          <s-stack gap="small">
            <SurveyPreview survey={preview} languages={languages} t={t} />
          </s-stack>
        </s-grid>
      </s-query-container>

      {detail.planLocked ? (
        <s-stack gap="small">
          <Banner tone="info" heading={t("library.available_on", { plan: t(`library.plan_${detail.requiredPlan}`) })}>
            <s-text>
              {detail.hasLite
                ? t("library.lite_note", { n: detail.liteQuestionCount, extra: liteExtra })
                : t("library.no_free_version")}
            </s-text>
          </Banner>
          <s-stack direction="inline" gap="small">
            {detail.hasLite ? (
              <Form method="post">
                <input type="hidden" name="lite" value="1" />
                <s-button variant="primary" type="submit">
                  {t("library.use_lite")}
                </s-button>
              </Form>
            ) : null}
            <s-link href="/app/plans">{t("library.see_plans")}</s-link>
          </s-stack>
        </s-stack>
      ) : (
        <Form method="post">
          <input type="hidden" name="lite" value="0" />
          <s-button variant="primary" type="submit">
            {t("library.use_template")}
          </s-button>
        </Form>
      )}
    </s-stack>
  );
}
