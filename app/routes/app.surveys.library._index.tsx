import { redirect, useLoaderData, useSearchParams, type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import type { BadgeTone } from "~/components/admin-ui";

import { Panel } from "~/components/admin-ui";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { createSurvey, type SurveyInput } from "~/lib/surveys.server";
import { ValidationError } from "~/lib/errors";
import { isEnabled } from "@shared/feature-flags";
import {
  CATEGORY_ORDER,
  catalogCards,
  catalogPlanFromKey,
  currentSpotlight,
  filterCards,
  templatePlacements,
  type CatalogCard,
  type CatalogPlan,
} from "@shared/templates/catalog";
import { buildSurveyDefinition } from "@shared/templates/resolve";
import { regionPackFor } from "@shared/templates/packs";
import { templateById } from "@shared/templates";
import { effectivePlan } from "~/lib/plans";
import { fetchShopLocaleInfo } from "~/lib/shopify-graphql.server";
import type { TemplateCategory } from "@shared/templates/types";

/**
 * Template library (T1).
 *
 * The gallery is goal-first: search, category tabs, combinable filters, outcome
 * tags and a single seasonal spotlight. No card carries more than two green tags
 * plus a "+N"; meta and plan info never use the success tone.
 *
 * "Use today" creates a real draft survey from the template and redirects into
 * Quick setup (`/app/surveys/<id>/setup`), so the merchant lands editing a copy,
 * not the template.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "library.title");

type CatalogSource = "survey_link";

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const { countryCode, timeZone } = await fetchShopLocaleInfo(shop.shopDomain, session.accessToken);
  const plan = catalogPlanFromKey(effectivePlan(shop));
  const surveyLinkEnabled = isEnabled("SURVEY_LINK_PAGE");

  const options = {
    locale: shop.language ?? "en",
    plan,
    country: countryCode,
    surveyLinkEnabled,
  };

  const cards = catalogCards(options);
  const spotlight = currentSpotlight({
    locale: shop.language ?? "en",
    region: regionPackFor(countryCode),
    now: new Date(),
    timeZone: timeZone ?? "UTC",
  });

  return {
    cards,
    spotlight,
    surveyLinkEnabled,
    categories: CATEGORY_ORDER.filter((c) => c !== "after_delivery" || surveyLinkEnabled),
    country: countryCode,
  };
});

export const action = guarded(async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const templateId = String(form.get("templateId") ?? "");
  const lite = form.get("lite") === "1";

  if (intent !== "use-template") {
    throw new ValidationError("Unknown action.", "Reload the page and try again.");
  }

  const template = templateById(templateId);
  if (!template) throw new ValidationError("That template does not exist.", "Pick another template.");

  // Quick setup (T3) owns creation: it walks the merchant through customize →
  // who sees it → review, then creates the survey. The setup route is keyed on
  // the TEMPLATE id; creating a survey here and redirecting with its id left an
  // orphan draft and a 404/500 in the wizard.
  return redirect(`/app/surveys/library/${template.id}/setup?lite=${lite ? "1" : "0"}`);
});

/** Optional questions start ON unless the Lite version excludes them. */
function buildDefaultToggles(questions: { key?: string; required: boolean; optionalInSetup?: boolean }[]): Record<string, boolean> {
  const toggles: Record<string, boolean> = {};
  for (const q of questions) {
    if (!q.required && q.optionalInSetup && q.key) toggles[q.key] = true;
  }
  return toggles;
}

function planTone(locked: boolean): BadgeTone {
  return locked ? "info" : "neutral";
}

function Card({ card }: { card: CatalogCard }) {
  const { t } = useAdminI18n();
  const shown = card.tags.slice(0, 2);
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small">
        <s-link href={`/app/surveys/library/${card.id}`}>
          <s-heading>{card.name}</s-heading>
        </s-link>
        <s-text color="subdued">{card.oneLiner}</s-text>
        <s-stack direction="inline" gap="small">
          {shown.map((tag) => (
            <span key={tag.id} title={tag.tip}>
              <s-badge tone="success">{tag.text}</s-badge>
            </span>
          ))}
          {card.extraTagCount > 0 ? (
            <s-badge tone="neutral">{`+${card.extraTagCount}`}</s-badge>
          ) : null}
        </s-stack>
        <s-text color="subdued" fontSize="small">
          {t("library.meta", { count: card.questionCount, seconds: card.seconds })}
        </s-text>
        {card.planLocked ? (
          <s-badge tone={planTone(true)}>
            {t("library.available_on", { plan: t(`library.plan_${card.requiredPlan}`) })}
          </s-badge>
        ) : null}
      </s-stack>
    </s-box>
  );
}

export default function TemplateLibrary() {
  const { cards, spotlight, surveyLinkEnabled, categories, country } = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();
  const [params, setParams] = useSearchParams();

  const q = params.get("q") ?? "";
  const category = (params.get("category") as TemplateCategory | "all" | null) ?? "all";
  const shortOnly = params.get("short") === "1";
  const freeOnly = params.get("free") === "1";
  const popularHere = params.get("popular") === "1";
  const thankYou = params.get("thank_you") === "1";
  const surveyLink = params.get("survey_link") === "1";

  const visible = filterCards(cards, {
    q,
    category,
    shortOnly,
    freeOnly,
    popularHere,
    country,
    thankYou,
    surveyLink,
  });

  const dismissSpotlight = params.get("spotlight") !== "off";

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true, preventScrollReset: true });
  }

  function toggle(key: string, on: boolean) {
    setParam(key, on ? "1" : null);
  }

  const filters: Array<{ key: string; label: string; on: boolean }> = [
    { key: "short", label: t("library.filter_short"), on: shortOnly },
    { key: "free", label: t("library.filter_free"), on: freeOnly },
    ...(country ? [{ key: "popular", label: t("library.filter_popular"), on: popularHere }] : []),
    { key: "thank_you", label: t("library.filter_thank_you"), on: thankYou },
    ...(surveyLinkEnabled ? [{ key: "survey_link", label: t("library.filter_survey_link"), on: surveyLink }] : []),
  ];

  return (
    <s-stack gap="base">
      <s-link href="/app/surveys">{t("library.back")}</s-link>
      <s-section heading={t("library.title")} subheading={t("library.subtitle")} padding="none" />

      {spotlight && dismissSpotlight ? (
        <s-banner tone="info" heading={spotlight.banner}>
          <s-stack direction="inline" gap="small">
            <s-link href={`/app/surveys/library/${spotlight.templateId}`}>
              {t("library.use_template")}
            </s-link>
            <s-button type="button" onClick={() => setParam("spotlight", "off")}>
              {t("library.spotlight_dismiss")}
            </s-button>
          </s-stack>
        </s-banner>
      ) : null}

      <s-text-field
        label={t("library.search_placeholder")}
        labelAccessibilityVisibility="exclusive"
        placeholder={t("library.search_placeholder")}
        value={q}
        onInput={(event: Event) => {
          const value = (event.target as HTMLInputElement).value;
          setParam("q", value.length > 0 ? value : null);
        }}
      />

      <s-stack direction="inline" gap="small">
        <s-button
          type="button"
          variant={category === "all" ? "primary" : undefined}
          onClick={() => setParam("category", null)}
        >
          {t("library.category_all")}
        </s-button>
        {categories.map((c) => (
          <s-button
            key={c}
            type="button"
            variant={category === c ? "primary" : undefined}
            onClick={() => setParam("category", c)}
          >
            {t(`library.category_${c}`)}
          </s-button>
        ))}
      </s-stack>

      <s-stack direction="inline" gap="small">
        {filters.map((filter) => (
          <s-button
            key={filter.key}
            type="button"
            variant={filter.on ? "primary" : undefined}
            onClick={() => toggle(filter.key, !filter.on)}
          >
            {filter.label}
          </s-button>
        ))}
      </s-stack>

      {visible.length === 0 ? (
        <Panel title={t("library.empty")}>
          <s-button type="button" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            {t("library.clear_filters")}
          </s-button>
        </Panel>
      ) : (
        <s-grid
          gridTemplateColumns="@container (inline-size > 760px) repeat(3, minmax(0, 1fr)), 1fr"
          gap="base"
        >
          {visible.map((card) => (
            <Card key={card.id} card={card} />
          ))}
        </s-grid>
      )}
    </s-stack>
  );
}
