import { useState } from "react";

import { AdvancedDisclosure, Banner } from "~/components/admin-ui";
import { checkboxChecked, fieldValue, TextField, type TFn } from "~/components/survey-editor";
import { LIMITS } from "@shared/survey-rules";
import type { EditorSurvey } from "~/lib/surveys.server";

/**
 * The Studio's Settings tab panels: targeting, Shopify sync and translations.
 *
 * Extracted from the old single-page editor so the Studio's right-panel modal
 * (who sees it) and the Settings tab share one implementation.
 */

function numberOrNull(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function NumberField({
  label,
  value,
  onInput,
}: {
  label: string;
  value: number | null;
  onInput: (value: number | null) => void;
}) {
  return (
    <s-number-field
      label={label}
      value={value != null ? String(value) : ""}
      onInput={(e: Event) => onInput(numberOrNull(fieldValue(e)))}
    />
  );
}

export function Targeting({
  draft,
  update,
  shopCurrency,
  t,
  limits,
  hideAdvanced = false,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  shopCurrency: string;
  t: TFn;
  limits: typeof LIMITS;
  hideAdvanced?: boolean;
}) {
  const targeting = draft.targeting;
  const set = (patch: Partial<typeof targeting>) => update({ targeting: { ...targeting, ...patch } });

  return (
    <s-stack gap="base">
      <s-select
        label={t("surveys.target_customer_type")}
        value={targeting.customerType ?? "everyone"}
        onChange={(e: Event) => set({ customerType: fieldValue(e) as "everyone" | "first_order" | "returning" })}
      >
        <s-option value="everyone">{t("surveys.customer_everyone")}</s-option>
        <s-option value="first_order">{t("surveys.customer_first")}</s-option>
        <s-option value="returning">{t("surveys.customer_returning")}</s-option>
      </s-select>

      <s-stack direction="inline" gap="small">
        <NumberField
          label={t("surveys.target_min_value", { currency: shopCurrency })}
          value={targeting.minValue ?? null}
          onInput={(v) => set({ minValue: v })}
        />
        <NumberField
          label={t("surveys.target_max_value", { currency: shopCurrency })}
          value={targeting.maxValue ?? null}
          onInput={(v) => set({ maxValue: v })}
        />
      </s-stack>
      <s-text color="subdued" fontSize="small">
        {t("surveys.target_value_help", { currency: shopCurrency })}
      </s-text>

      {!hideAdvanced ? (
        <AdvancedDisclosure label={t("surveys.section_advanced")}>
          <s-stack gap="base">
            <s-number-field
              label={t("surveys.target_sample")}
              min={1}
              max={100}
              value={targeting.samplePercent != null ? String(targeting.samplePercent) : "100"}
              onInput={(e: Event) => set({ samplePercent: numberOrNull(fieldValue(e)) ?? 100 })}
            />
            <s-text-field
              label={t("surveys.target_countries")}
              value={(targeting.countries ?? []).join(", ")}
              onInput={(e: Event) =>
                set({
                  countries: fieldValue(e)
                    .split(",")
                    .map((c) => c.trim().toUpperCase())
                    .filter(Boolean),
                })
              }
            />
            <s-text-field
              label={t("surveys.target_languages")}
              value={(targeting.languages ?? []).join(", ")}
              onInput={(e: Event) =>
                set({
                  languages: fieldValue(e)
                    .split(",")
                    .map((l) => l.trim())
                    .filter(Boolean),
                })
              }
            />
            <s-stack direction="inline" gap="small">
              <s-text-field
                label={t("surveys.target_starts")}
                placeholder="YYYY-MM-DD"
                value={targeting.startsAt ? targeting.startsAt.slice(0, 10) : ""}
                onInput={(e: Event) => set({ startsAt: fieldValue(e) || null })}
              />
              <s-text-field
                label={t("surveys.target_ends")}
                placeholder="YYYY-MM-DD"
                value={targeting.endsAt ? targeting.endsAt.slice(0, 10) : ""}
                onInput={(e: Event) => set({ endsAt: fieldValue(e) || null })}
              />
            </s-stack>
            <NumberField
              label={t("surveys.target_max_responses")}
              value={targeting.maxResponses ?? null}
              onInput={(v) => set({ maxResponses: v })}
            />
            <s-text color="subdued" fontSize="small">
              {t("surveys.target_products_note", { max: limits.MAX_TARGET_PRODUCTS })}
            </s-text>
          </s-stack>
        </AdvancedDisclosure>
      ) : null}
    </s-stack>
  );
}

export function SyncSettings({
  draft,
  update,
  t,
  grantedScopes,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  grantedScopes: string[];
}) {
  const raw = (draft.syncOptions ?? {}) as {
    orderTags?: unknown;
    customerTags?: unknown;
    metafields?: unknown;
    flowTrigger?: unknown;
  };

  const tagText = (value: unknown): string => (Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : "");
  // Mirrors MAX_SYNC_TAGS in app/lib/sync.server.ts. A local constant, not an
  // import, because that module pulls in the database and must never reach the
  // browser bundle.
  const maxTags = 4;
  const parseTags = (value: string): string[] =>
    value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, maxTags);

  const set = (patch: Record<string, unknown>) => update({ syncOptions: { ...raw, ...patch } });

  const writeOrders = grantedScopes.includes("write_orders");
  const writeCustomers = grantedScopes.includes("write_customers");

  return (
    <s-stack gap="base">
      <s-text color="subdued" fontSize="small">
        {t("surveys.sync_intro")}
      </s-text>

      {!writeOrders && !writeCustomers ? (
        <Banner tone="info" heading={t("surveys.sync_no_scopes_title")}>
          {t("surveys.sync_no_scopes_body")}
        </Banner>
      ) : null}

      <s-text-field
        label={t("surveys.sync_order_tags")}
        value={tagText(raw.orderTags)}
        onInput={(e: Event) => set({ orderTags: parseTags(fieldValue(e)) })}
      />
      <s-text color="subdued" fontSize="small">
        {t("surveys.sync_order_tags_help")}
      </s-text>

      <s-text-field
        label={t("surveys.sync_customer_tags")}
        value={tagText(raw.customerTags)}
        onInput={(e: Event) => set({ customerTags: parseTags(fieldValue(e)) })}
      />
      <s-text color="subdued" fontSize="small">
        {t("surveys.sync_customer_tags_help")}
      </s-text>

      <s-checkbox
        name="sync-order-metafield"
        label={t("surveys.sync_metafield")}
        checked={Array.isArray(raw.metafields) && raw.metafields.length > 0 ? true : undefined}
        onChange={(e: Event) =>
          set({
            metafields: checkboxChecked(e)
              ? [{ namespace: "sourcetrac", key: "channel", type: "single_line_text_field" }]
              : [],
          })
        }
      />

      <s-checkbox
        name="sync-flow"
        label={t("surveys.sync_flow")}
        checked={raw.flowTrigger === true ? true : undefined}
        onChange={(e: Event) => set({ flowTrigger: checkboxChecked(e) })}
      />
      <s-text color="subdued" fontSize="small">
        {t("surveys.sync_flow_help")}
      </s-text>
    </s-stack>
  );
}

export function Translations({
  draft,
  update,
  languages,
  t,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  languages: Array<{ code: string; name: string }>;
  t: TFn;
}) {
  const [locale, setLocale] = useState(languages[0]?.code ?? "en");
  const translations = (draft.translations ?? {}) as Record<string, Record<string, unknown>>;
  const current = translations[locale] ?? {};

  const setLocaleText = (key: string, value: string) => {
    update({ translations: { ...translations, [locale]: { ...current, [key]: value } } });
  };

  const setQuestionText = (questionId: string, key: string, value: string) => {
    const questions = { ...((current.questions as Record<string, Record<string, string>>) ?? {}) };
    questions[questionId] = { ...(questions[questionId] ?? {}), [key]: value };
    update({ translations: { ...translations, [locale]: { ...current, questions } } });
  };

  return (
    <s-stack gap="base">
      <s-select label={t("surveys.translation_language")} value={locale} onChange={(e: Event) => setLocale(fieldValue(e))}>
        {languages.map((language) => (
          <s-option key={language.code} value={language.code}>
            {language.name}
          </s-option>
        ))}
      </s-select>
      <s-text color="subdued" fontSize="small">
        {t("surveys.translation_help")}
      </s-text>

      <s-text-field
        label={t("surveys.field_title")}
        value={String(current.title ?? "")}
        onInput={(e: Event) => setLocaleText("title", fieldValue(e))}
      />
      <s-text-field
        label={t("surveys.field_intro")}
        value={String(current.intro ?? "")}
        onInput={(e: Event) => setLocaleText("intro", fieldValue(e))}
      />
      <s-text-field
        label={t("surveys.field_button")}
        value={String(current.buttonLabel ?? "")}
        onInput={(e: Event) => setLocaleText("buttonLabel", fieldValue(e))}
      />
      <s-text-field
        label={t("surveys.field_thank_you")}
        value={String(current.thankYouText ?? "")}
        onInput={(e: Event) => setLocaleText("thankYouText", fieldValue(e))}
      />

      {draft.questions.map((question, index) => (
        <s-text-field
          key={question.id || `tq-${index}`}
          label={t("surveys.translation_question", { n: index + 1 })}
          value={String(((current.questions as Record<string, Record<string, string>>) ?? {})[question.id]?.text ?? "")}
          onInput={(e: Event) => setQuestionText(question.id, "text", fieldValue(e))}
        />
      ))}
    </s-stack>
  );
}

export { TextField };
