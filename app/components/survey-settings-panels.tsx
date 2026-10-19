import { useState } from "react";

import { Banner } from "~/components/admin-ui";
import { CountryPicker } from "~/components/country-picker";
import { JustInTimeNotice } from "~/components/data-notice";
import { LockedNote, checkboxChecked, fieldValue, numberOrNull, type TFn } from "~/components/survey-editor";
import { LIMITS } from "@shared/survey-rules";
import { planHas, usesAdvancedTargeting, type PlanTier } from "@shared/plan-features";
import { SMART_ACTION_PRESETS } from "@shared/templates/smart-actions";
import { normalizeTagTemplates, tagsForAnswer } from "@shared/sync-tags";
import { endOfDayIso, startOfDayIso, storedToDateField } from "@shared/zoned-date";
import type { EditorSurvey } from "~/lib/surveys.server";

/**
 * The editor's settings sections: who sees the survey, Shopify actions,
 * automation and languages.
 *
 * A paid section shows what it does and a "See plans" link instead of disabled
 * controls. A survey that already uses a paid setting (set up before a
 * downgrade) keeps its controls, so the merchant can still turn it off.
 */

type Update = (patch: Partial<EditorSurvey>) => void;

function NumberField({ label, value, onInput, details }: { label: string; value: number | null; onInput: (value: number | null) => void; details?: string }) {
  return (
    <s-number-field
      label={label}
      details={details}
      min={1}
      value={value != null ? String(value) : ""}
      onInput={(e: Event) => onInput(numberOrNull(fieldValue(e)))}
    />
  );
}

/** Who sees it: everyone, first-time or returning buyers (every plan). */
export function Audience({ draft, update, t }: { draft: EditorSurvey; update: Update; t: TFn }) {
  const targeting = draft.targeting;
  const value = targeting.customerType ?? "everyone";
  return (
    <s-choice-list
      label={t("editor.audience")}
      name="audience"
      values={[value]}
      onChange={(e: Event) => {
        const next = (e.currentTarget as { values?: string[] }).values?.[0] ?? "everyone";
        const { customerType: _drop, ...rest } = targeting;
        update({ targeting: next === "everyone" ? rest : { ...rest, customerType: next as "first_order" | "returning" } });
      }}
    >
      <s-choice value="everyone">{t("editor.audience_everyone")}</s-choice>
      <s-choice value="first_order">{t("editor.audience_first")}</s-choice>
      <s-choice value="returning">{t("editor.audience_returning")}</s-choice>
    </s-choice-list>
  );
}

/** Order value, share of orders, countries, dates, answer limit (Growth). */
export function AdvancedTargeting({
  draft,
  update,
  shopCurrency,
  shopTimeZone,
  language,
  errors,
  t,
  plan,
}: {
  draft: EditorSurvey;
  update: Update;
  shopCurrency: string;
  /** The store's IANA zone; dates are the store's calendar days. */
  shopTimeZone: string | null;
  /** The merchant's admin language, for country names. */
  language: string;
  errors: Map<string, string>;
  t: TFn;
  plan: PlanTier;
}) {
  const targeting = draft.targeting;
  const set = (patch: Partial<typeof targeting>) => update({ targeting: { ...targeting, ...patch } });

  if (!planHas(plan, "advanced_targeting") && !usesAdvancedTargeting(targeting)) {
    return <LockedNote t={t} plan="growth">{t("editor.targeting_locked", { plan: t("plans.growth") })}</LockedNote>;
  }

  // The bounds are in the store's currency, and the rule only applies to
  // orders in that currency. `valueCurrency` was never set, so the rule was
  // skipped on every order and the survey showed whatever the total.
  const setValue = (patch: { minValue?: number | null; maxValue?: number | null }) =>
    set({ ...patch, valueCurrency: shopCurrency });
  const zone = shopTimeZone ?? "UTC";

  return (
    <s-stack gap="base">
      <s-stack gap="small-200">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 11rem), 1fr))" gap="small">
          <NumberField
            label={t("editor.min_value", { currency: shopCurrency })}
            value={targeting.minValue ?? null}
            onInput={(v) => setValue({ minValue: v })}
          />
          <NumberField
            label={t("editor.max_value", { currency: shopCurrency })}
            value={targeting.maxValue ?? null}
            onInput={(v) => setValue({ maxValue: v })}
          />
        </s-grid>
        <s-text color="subdued" fontSize="small">
          {t("editor.order_value_details", { currency: shopCurrency })}
        </s-text>
      </s-stack>
      <s-number-field
        label={t("editor.sample")}
        details={t("editor.sample_details")}
        min={1}
        max={100}
        suffix="%"
        value={targeting.samplePercent != null ? String(targeting.samplePercent) : "100"}
        error={errors.get("targeting.samplePercent")}
        onInput={(e: Event) => {
          const v = numberOrNull(fieldValue(e));
          // 100% is everyone: store no rule rather than a no-op one.
          set({ samplePercent: v == null || v >= 100 ? undefined : Math.max(1, Math.round(v)) });
        }}
      />
      <NumberField
        label={t("editor.max_responses")}
        details={t("editor.max_responses_details")}
        value={targeting.maxResponses ?? null}
        onInput={(v) => set({ maxResponses: v })}
      />
      <CountryPicker
        value={targeting.countries ?? []}
        onChange={(codes) => set({ countries: codes.length > 0 ? codes : undefined })}
        language={language}
        error={errors.get("targeting.countries")}
        t={t}
      />
      <s-stack gap="small-200">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 11rem), 1fr))" gap="small">
          <s-date-field
            label={t("editor.starts")}
            value={storedToDateField(targeting.startsAt, "start", zone)}
            error={errors.get("targeting.startsAt")}
            onChange={(e: Event) => {
              const day = fieldValue(e);
              set({ startsAt: day ? startOfDayIso(day, zone) : null });
            }}
          />
          <s-date-field
            label={t("editor.ends")}
            value={storedToDateField(targeting.endsAt, "end", zone)}
            error={errors.get("targeting.endsAt")}
            onChange={(e: Event) => {
              const day = fieldValue(e);
              set({ endsAt: day ? endOfDayIso(day, zone) : null });
            }}
          />
        </s-grid>
        <s-text color="subdued" fontSize="small">
          {t("editor.dates_details", { zone })}
        </s-text>
      </s-stack>
    </s-stack>
  );
}

/** Order and customer tags, metafields and the Flow trigger (Scale). */
export function ShopifyActions({
  draft,
  update,
  t,
  grantedScopes,
  plan,
  templatePresets,
}: {
  draft: EditorSurvey;
  update: Update;
  t: TFn;
  grantedScopes: string[];
  plan: PlanTier;
  /** The smart-action presets the survey's template offers (T13). */
  templatePresets: string[];
}) {
  const raw = (draft.syncOptions ?? {}) as {
    orderTags?: unknown;
    customerTags?: unknown;
    metafields?: unknown;
    flowTrigger?: unknown;
    presets?: unknown;
  };
  const presets = Array.isArray(raw.presets) ? raw.presets.filter((p): p is string => typeof p === "string") : [];
  const inUse =
    presets.length > 0 ||
    raw.flowTrigger === true ||
    [raw.orderTags, raw.customerTags, raw.metafields].some((v) => Array.isArray(v) && v.length > 0);

  if (!planHas(plan, "shopify_actions") && !inUse) {
    return <LockedNote t={t} plan="scale">{t("editor.actions_locked", { plan: t("plans.scale") })}</LockedNote>;
  }

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
  // Tags and the metafield carry the answer to the survey's channel question,
  // the first single-choice or dropdown question.
  const channelQuestion =
    draft.questions.find((q) => q.id === draft.channelReportQuestionId) ??
    draft.questions.find((q) => q.type === "single_choice" || q.type === "dropdown");
  const exampleAnswer = channelQuestion?.options.find((o) => !o.isOther)?.label ?? "Instagram";

  return (
    <s-stack gap="base">
      {/* Shopify actions are where answers leave SourceTrac, so the notice
          sits on the panel that switches them on. */}
      <JustInTimeNotice>{t("privacy.actions_notice")}</JustInTimeNotice>
      {grantedScopes.length === 0 ? (
        <Banner tone="info" heading={t("surveys.sync_no_scopes_title")}>
          {t("surveys.sync_no_scopes_body")}
        </Banner>
      ) : null}

      {templatePresets.length > 0 ? (
        <s-stack gap="small">
          <s-text type="strong">{t("editor.presets")}</s-text>
          {templatePresets.map((id) => {
            const preset = SMART_ACTION_PRESETS[id];
            const name = (preset?.name ?? id).replace(":{optionKey}", ":…").replace("{optionKey}", "…");
            return (
              <s-checkbox
                key={id}
                label={name}
                details={t(preset?.exampleKey ?? "smart_actions.example_order_tag", { tag: name, field: name })}
                checked={presets.includes(id) || undefined}
                onChange={(e: Event) =>
                  set({ presets: checkboxChecked(e) ? [...new Set([...presets, id])] : presets.filter((p) => p !== id) })
                }
              />
            );
          })}
        </s-stack>
      ) : null}

      <s-text color="subdued">
        {channelQuestion
          ? t("editor.actions_channel_question", { question: channelQuestion.text || t("preview.untitled") })
          : t("editor.actions_no_channel_question")}
      </s-text>
      <s-text-field
        label={t("surveys.sync_order_tags")}
        details={t("surveys.sync_order_tags_help")}
        value={tagText(raw.orderTags)}
        onInput={(e: Event) => set({ orderTags: parseTags(fieldValue(e)) })}
      />
      <TagExample templates={raw.orderTags} answer={exampleAnswer} t={t} />
      <s-text-field
        label={t("surveys.sync_customer_tags")}
        details={t("surveys.sync_customer_tags_help")}
        value={tagText(raw.customerTags)}
        onInput={(e: Event) => set({ customerTags: parseTags(fieldValue(e)) })}
      />
      <TagExample templates={raw.customerTags} answer={exampleAnswer} t={t} />
      <s-checkbox
        label={t("surveys.sync_metafield")}
        details={t("surveys.sync_metafield_help")}
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
        label={t("surveys.sync_flow")}
        details={t("surveys.sync_flow_help")}
        checked={raw.flowTrigger === true ? true : undefined}
        onChange={(e: Event) => set({ flowTrigger: checkboxChecked(e) })}
      />
    </s-stack>
  );
}

/** The tags one answer would get, written by the same code as the sync. */
function TagExample({ templates, answer, t }: { templates: unknown; answer: string; t: TFn }) {
  const tags = tagsForAnswer(normalizeTagTemplates(templates) ?? [], answer);
  if (tags.length === 0) return null;
  return (
    <s-text color="subdued" fontSize="small">
      {t("editor.tags_example", { answer, tags: tags.join(", ") })}
    </s-text>
  );
}

/** Stop once the answer is clear, and rotate surveys (Scale). */
export function Automation({ draft, update, t, plan }: { draft: EditorSurvey; update: Update; t: TFn; plan: PlanTier }) {
  const canStop = planHas(plan, "auto_stop") || draft.learnAndStop;
  const canRotate = planHas(plan, "rotation") || draft.rotation;
  if (!canStop && !canRotate) {
    return <LockedNote t={t} plan="scale">{t("editor.automation_locked", { plan: t("plans.scale") })}</LockedNote>;
  }
  return (
    <s-stack gap="base">
      {canStop ? (
        <s-stack gap="small-200">
          <s-switch
            label={t("setup.learn_stop")}
            details={t("setup.learn_stop_help")}
            checked={draft.learnAndStop || undefined}
            onChange={(e: Event) => update({ learnAndStop: checkboxChecked(e) })}
          />
          {draft.learnAndStop && draft.autoPausedAt ? (
            <s-text color="subdued" fontSize="small">
              {t("editor.learn_stop_done")}
            </s-text>
          ) : null}
        </s-stack>
      ) : null}
      {canRotate ? (
        <s-switch
          label={t("setup.rotation")}
          details={t("setup.rotation_help")}
          checked={draft.rotation || undefined}
          onChange={(e: Event) => update({ rotation: checkboxChecked(e) })}
        />
      ) : null}
    </s-stack>
  );
}

/**
 * Per-language wording. Surveys made from a template arrive translated into
 * every language the app ships; this is where a merchant checks or changes a
 * line. A blank field means buyers in that language read the default wording.
 */
export function Languages({
  draft,
  update,
  languages,
  defaultLanguage,
  t,
  limits,
}: {
  draft: EditorSurvey;
  update: Update;
  languages: Array<{ code: string; name: string }>;
  defaultLanguage: string;
  t: TFn;
  limits: typeof LIMITS;
}) {
  const others = languages.filter((l) => l.code !== defaultLanguage);
  const [locale, setLocale] = useState(others[0]?.code ?? "");
  const frame = (draft.translations ?? {}) as Record<string, Record<string, unknown>>;
  const current = frame[locale] ?? {};
  const translatedCount = others.filter((l) => draft.questions.some((q) => (q.translations?.[l.code]?.text ?? "") !== "")).length;

  const setFrame = (field: string, value: string) => {
    const nextEntry = { ...current, [field]: value };
    if (!value) delete nextEntry[field];
    update({ translations: { ...frame, [locale]: nextEntry } });
  };
  const setQuestion = (index: number, value: string) => {
    update({
      questions: draft.questions.map((q, i) => {
        if (i !== index) return q;
        const entry = { ...(q.translations?.[locale] ?? {}), text: value };
        if (!value) delete (entry as { text?: string }).text;
        return { ...q, translations: { ...q.translations, [locale]: entry } };
      }),
    });
  };
  const setOption = (qi: number, oi: number, value: string) => {
    update({
      questions: draft.questions.map((q, i) =>
        i !== qi
          ? q
          : {
              ...q,
              options: q.options.map((o, j) => {
                if (j !== oi) return o;
                const next = { ...o.translations };
                if (value) next[locale] = value;
                else delete next[locale];
                return { ...o, translations: next };
              }),
            },
      ),
    });
  };

  if (others.length === 0) return null;

  return (
    <s-stack gap="base">
      <s-text color="subdued">{t("editor.languages_help", { count: translatedCount })}</s-text>
      <s-select label={t("editor.language")} value={locale} onChange={(e: Event) => setLocale(fieldValue(e))}>
        {others.map((language) => (
          <s-option key={language.code} value={language.code}>
            {language.name}
          </s-option>
        ))}
      </s-select>

      {draft.questions.map((question, qi) => (
        <s-box key={question.id || qi} padding="small" border="base" borderRadius="base">
          <s-stack gap="small">
            <s-text-field
              label={t("editor.question_n", { n: qi + 1 })}
              placeholder={question.text}
              maxLength={limits.MAX_QUESTION_TEXT}
              value={question.translations?.[locale]?.text ?? ""}
              onInput={(e: Event) => setQuestion(qi, fieldValue(e))}
            />
            {question.options
              .filter((o) => !o.isOther)
              .map((option) => {
                const oi = question.options.indexOf(option);
                return (
                  <s-text-field
                    key={option.id || oi}
                    label={option.label}
                    placeholder={option.label}
                    maxLength={limits.MAX_OPTION_LABEL}
                    value={option.translations?.[locale] ?? ""}
                    onInput={(e: Event) => setOption(qi, oi, fieldValue(e))}
                  />
                );
              })}
          </s-stack>
        </s-box>
      ))}

      <details className="st-details">
        <summary>{t("editor.languages_frame")}</summary>
        <s-stack gap="small">
          <s-text-field label={t("editor.title")} placeholder={draft.title} maxLength={limits.MAX_SURVEY_TITLE} value={String(current.title ?? "")} onInput={(e: Event) => setFrame("title", fieldValue(e))} />
          <s-text-field label={t("editor.intro")} placeholder={draft.intro ?? ""} maxLength={limits.MAX_INTRO_TEXT} value={String(current.intro ?? "")} onInput={(e: Event) => setFrame("intro", fieldValue(e))} />
          <s-text-field label={t("editor.button")} placeholder={draft.buttonLabel} maxLength={limits.MAX_BUTTON_LABEL} value={String(current.buttonLabel ?? "")} onInput={(e: Event) => setFrame("buttonLabel", fieldValue(e))} />
          <s-text-field label={t("editor.thanks")} placeholder={draft.thankYouText} maxLength={limits.MAX_THANK_YOU_TEXT} value={String(current.thankYouText ?? "")} onInput={(e: Event) => setFrame("thankYouText", fieldValue(e))} />
        </s-stack>
      </details>
    </s-stack>
  );
}
