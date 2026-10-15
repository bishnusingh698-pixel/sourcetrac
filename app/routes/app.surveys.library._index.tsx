import { Form, redirect, useActionData, useLoaderData, useNavigation, useSearchParams, type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Banner, PageIntro } from "~/components/admin-ui";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { createTranslator } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { createSurvey } from "~/lib/surveys.server";
import { templateSurveyInput } from "~/lib/template-survey";
import { NotFoundError, ValidationError } from "~/lib/errors";
import { effectivePlan } from "~/lib/plans";
import { fetchShopLocaleInfo } from "~/lib/shopify-graphql.server";
import { isEnabled } from "@shared/feature-flags";
import { CATEGORY_ORDER, catalogPlanFromKey, templateHasFreeVersion, templateLockedForPlan } from "@shared/templates/catalog";
import { buildSurveyDefinition } from "@shared/templates/resolve";
import { regionPackFor } from "@shared/templates/packs";
import { templateText } from "@shared/templates/locales";
import { templateById, TEMPLATES } from "@shared/templates";
import { describeFollowUp } from "@shared/survey-summary";
import type { TemplateCategory } from "@shared/templates/types";

/**
 * Choose a template.
 *
 * One screen, one decision. Every card says in plain words what the merchant
 * learns, shows the exact questions buyers will see, and has one button. That
 * button creates the survey straight away and opens it in the editor; there is
 * no separate detail page or setup wizard to get lost in.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "library.title");

export const handle = { titleKey: "library.title" };

/** The template most stores should start with, shown on its own at the top. */
const RECOMMENDED_ID = "channel-compass";

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const { countryCode } = await fetchShopLocaleInfo(shop.shopDomain, session.accessToken);
  const locale = resolveAdminLanguage(request, shop.language, shop.adminLocale);
  const region = regionPackFor(countryCode);
  const plan = catalogPlanFromKey(effectivePlan(shop));
  const surveyLinkEnabled = isEnabled("SURVEY_LINK_PAGE");

  const cards = TEMPLATES.filter((t) => t.category !== "after_delivery" || surveyLinkEnabled).map((template) => {
    const locked = templateLockedForPlan(template, plan);
    const hasFree = templateHasFreeVersion(template);
    // The questions the merchant would actually get on their plan, in their
    // language: the Free version when the full one needs Growth.
    const fullCount = buildSurveyDefinition({ template, locale, region }).questions.length;
    const definition = buildSurveyDefinition({ template, locale, region, lite: locked && hasFree });
    const questions = definition.questions.map((question) => ({
      text: question.text,
      followUp: describeFollowUp(question, definition.questions),
    }));
    return {
      id: template.id,
      category: template.category,
      name: templateText(locale, template.nameKey),
      oneLiner: templateText(locale, template.oneLinerKey),
      questions,
      fullCount,
      // "full": everything included. "free_version": the plan gets fewer
      // questions. "paid": the plan cannot use this template.
      access: !locked ? "full" : hasFree ? "free_version" : "paid",
    } as const;
  });

  return {
    cards,
    recommendedId: RECOMMENDED_ID,
    categories: CATEGORY_ORDER.filter((c) => cards.some((card) => card.category === c)),
  };
});

export const action = guarded(async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const locale = resolveAdminLanguage(request, shop.language, shop.adminLocale);

  try {
    if (intent === "blank") {
      const t = createTranslator(locale);
      const survey = await createSurvey(shop.id, {
        name: t("library.blank_name"),
        status: "draft",
        placements: ["thank_you", "order_status"],
        layout: "all",
        title: t("library.blank_title"),
        intro: null,
        buttonLabel: t("library.blank_button"),
        thankYouText: t("library.blank_thanks"),
        questions: [
          {
            type: "single_choice",
            text: t("survey_defaults.question"),
            required: true,
            allowOther: true,
            randomizeOptions: true,
            options: [
              { label: t("survey_defaults.instagram") },
              { label: t("survey_defaults.google") },
              { label: t("survey_defaults.friend-or-family") },
              { label: t("survey_defaults.tiktok") },
            ],
          },
        ],
      });
      return redirect(`/app/surveys/${survey.id}?created=1`);
    }

    if (intent !== "use-template") {
      throw new ValidationError("Unknown action.", "Reload the page and try again.");
    }

    const template = templateById(String(form.get("templateId") ?? ""));
    if (!template) throw new NotFoundError("That template does not exist.");
    const { countryCode } = await fetchShopLocaleInfo(shop.shopDomain, session.accessToken);
    const built = templateSurveyInput({
      template,
      locale,
      region: regionPackFor(countryCode),
      plan: effectivePlan(shop),
    });
    if (!built.ok) return { ok: false as const, code: "template_plan_locked" };
    const survey = await createSurvey(shop.id, built.input);
    return redirect(`/app/surveys/${survey.id}?created=1${built.lite ? "&free_version=1" : ""}`);
  } catch (error) {
    // A full account (too many surveys) or a stale template id is shown on the
    // page, not as the generic error screen.
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      const code = typeof error.fields.code === "string" ? error.fields.code : error.code;
      return { ok: false as const, code };
    }
    throw error;
  }
});

type Card = Awaited<ReturnType<typeof loader>>["cards"][number];

export default function TemplateLibrary() {
  const { cards, recommendedId, categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { t } = useAdminI18n();
  const [params, setParams] = useSearchParams();
  const category = (params.get("category") as TemplateCategory | null) ?? null;

  const recommended = cards.find((card) => card.id === recommendedId);
  // The recommended card has its own spot above the list, so it is left out
  // of "All"; once a category is picked it is listed with the others again,
  // or picking its own category would hide it.
  const rest = cards.filter((card) => (category ? card.category === category : card.id !== recommendedId));

  const failureKey = actionData?.ok === false ? `surveys.validation_${actionData.code}` : null;
  const failure = failureKey ? (t(failureKey) === failureKey ? t("library.create_failed") : t(failureKey)) : null;

  const setCategory = (next: string | null) => {
    const search = new URLSearchParams(params);
    if (next) search.set("category", next);
    else search.delete("category");
    setParams(search, { replace: true, preventScrollReset: true });
  };

  return (
    <s-stack gap="base">
      <s-link href="/app/surveys">{t("library.back")}</s-link>
      <PageIntro
        actions={
          <Form method="post">
            <input type="hidden" name="intent" value="blank" />
            <s-button type="submit">{t("library.start_blank")}</s-button>
          </Form>
        }
      >
        {t("library.subtitle")}
      </PageIntro>

      {failure ? <Banner tone="critical" heading={failure} /> : null}

      {recommended && !category ? (
        <s-section>
          <s-stack gap="small">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-badge tone="success" icon="star">
                {t("library.recommended")}
              </s-badge>
              <s-text color="subdued" fontSize="small">
                {t("library.recommended_why")}
              </s-text>
            </s-stack>
            <TemplateCard card={recommended} primary />
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading={t("library.more_title")}>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small">
            <s-button type="button" variant={!category ? "primary" : "secondary"} onClick={() => setCategory(null)}>
              {t("library.category_all")}
            </s-button>
            {categories.map((c) => (
              <s-button key={c} type="button" variant={category === c ? "primary" : "secondary"} onClick={() => setCategory(c)}>
                {t(`library.category_${c}`)}
              </s-button>
            ))}
          </s-stack>

          <s-query-container>
            <s-grid
              gridTemplateColumns="repeat(auto-fill, minmax(min(100%, 16rem), 1fr))"
              gap="base"
            >
              {rest.map((card) => (
                <TemplateCard key={card.id} card={card} />
              ))}
            </s-grid>
          </s-query-container>
        </s-stack>
      </s-section>
    </s-stack>
  );
}

function TemplateCard({ card, primary = false }: { card: Card; primary?: boolean }) {
  const { t } = useAdminI18n();
  const navigation = useNavigation();
  const creating = navigation.state !== "idle" && navigation.formData?.get("templateId") === card.id;
  const [first, ...more] = card.questions;

  return (
    <s-box padding="base" border="base" borderRadius="large" background={primary ? "subdued" : undefined}>
      <s-stack gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-heading>{card.name}</s-heading>
          {card.access === "paid" ? <s-badge tone="info">{t("library.needs_plan", { plan: t("plans.growth") })}</s-badge> : null}
        </s-stack>
        <s-text color="subdued">{card.oneLiner}</s-text>

        {first ? (
          <s-box padding="small" borderRadius="base" background="base" border="base">
            <s-stack gap="small-200">
              <s-text type="strong">{`“${first.text}”`}</s-text>
              {more.length > 0 ? (
                <details className="st-details">
                  <summary>{t("library.more_questions", { count: more.length })}</summary>
                  <ol className="st-question-list" start={2}>
                    {more.map((q, i) => (
                      <li key={i}>
                        <s-text>{q.text}</s-text>
                        {q.followUp ? (
                          <s-text color="subdued" fontSize="small">
                            {" "}
                            {t("library.follow_up", { n: q.followUp.parentNumber })}
                          </s-text>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </s-stack>
          </s-box>
        ) : null}

        <s-text color="subdued" fontSize="small">
          {t("library.meta", { count: card.questions.length, seconds: card.questions.length * 8 })}
        </s-text>
        {card.access === "free_version" ? (
          <s-text color="subdued" fontSize="small">
            {t("library.free_version_note", { n: card.questions.length, total: card.fullCount, plan: t("plans.growth") })}
          </s-text>
        ) : null}

        {card.access === "paid" ? (
          <s-button href="/app/plans">{t("library.see_plans")}</s-button>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="use-template" />
            <input type="hidden" name="templateId" value={card.id} />
            <s-button type="submit" variant={primary ? "primary" : "secondary"} loading={creating || undefined}>
              {t("library.use_template")}
            </s-button>
          </Form>
        )}
      </s-stack>
    </s-box>
  );
}
