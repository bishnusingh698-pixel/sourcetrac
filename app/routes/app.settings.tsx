import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import {
  DEFAULT_OPTIONS,
  EMOJI_MAX_LENGTH,
  isUntouchedDefaultSurvey,
  MAX_OPTION_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  parseSurveySettings,
  validateSurveySettings,
  validationI18n,
  type I18nText,
} from "~/lib/settings";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { updateSettings } from "~/lib/shop.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { db } from "~/db.server";

/**
 * Survey settings: the question text and its answer options.
 *
 * One primary action: "Save changes".
 *
 * Options are edited in local state and submitted as a single `option[]`-style
 * payload. Reordering is therefore an instant client-side array move rather than
 * a round trip, and the saved order is exactly what the merchant sees. Nothing
 * is persisted until Save — merchants expect "Add option" not to silently change
 * their live survey.
 *
 * Validation runs on the server in `validateSurveySettings`, the same function
 * the public survey-config endpoint uses, so the rules cannot drift between the
 * form and the API. Errors come back keyed by field and render inline.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "settings.title");

type DraftOption = { value: string; label: string; emoji: string };

/**
 * Polaris fields are custom elements that expose `value`/`checked` as element
 * properties, not as an inner `<input>` the event target can be cast to. These
 * readers keep the casts in one place.
 */
function fieldValue(event: { currentTarget: unknown }): string {
  const target = event.currentTarget as { value?: unknown };
  return typeof target.value === "string" ? target.value : "";
}

function switchChecked(event: { currentTarget: unknown }): boolean {
  const target = event.currentTarget as { checked?: unknown };
  return target.checked === true;
}

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const options = parseSurveySettings(shop.optionsJson, {
    questionText: shop.questionText,
    options: [],
    allowOther: shop.allowOther,
  }).options;

  // Offer translated defaults only before the first answer. Rewording an
  // option changes its channel key, so doing it after answers exist would
  // split one channel's history across two rows.
  const untouched = isUntouchedDefaultSurvey(shop.questionText, options);
  const hasResponses = untouched ? (await db.surveyResponse.count({ where: { shopId: shop.id }, take: 1 })) > 0 : true;

  return {
    questionText: shop.questionText,
    allowOther: shop.allowOther,
    options,
    offerTranslatedDefaults: untouched && !hasResponses,
    min: MIN_OPTIONS,
    max: MAX_OPTIONS,
  };
});

export const action = guarded(async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);

  const form = await request.formData();

  // Options arrive in the order the form rendered them, as parallel `label`
  // and `emoji` arrays. Lengths are reconciled so a missing emoji field cannot
  // shift labels onto the wrong options.
  const labels = form.getAll("label").map(String);
  const emojis = form.getAll("emoji").map(String);

  const existing = parseSurveySettings(shop.optionsJson, {
    questionText: shop.questionText,
    options: [],
    allowOther: shop.allowOther,
  }).options;

  try {
    const settings = validateSurveySettings(
      {
        questionText: form.get("questionText"),
        options: labels.map((label, index) => ({ label, emoji: emojis[index] ?? "" })),
        allowOther: form.get("allowOther") === "true",
      },
      existing,
    );

    await updateSettings(shop.id, {
      questionText: settings.questionText,
      optionsJson: JSON.stringify(settings.options),
      allowOther: settings.allowOther,
    });

    return {
      ok: true as const,
      message: { key: "settings.saved_body" } as I18nText,
      hint: undefined as I18nText | undefined,
      fieldErrors: {} as Record<string, I18nText>,
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      const field = error.fields.field;
      // Keys, not English: the action cannot know which language the page
      // is in, so the component translates. An error from a validator that
      // predates the keys falls back to the generic message rather than
      // showing English to a merchant reading Japanese.
      const i18n = validationI18n(error) ?? { message: { key: "validation.settings_invalid" } };
      return {
        ok: false as const,
        message: i18n.message,
        hint: i18n.hint,
        fieldErrors:
          typeof field === "string"
            ? { [field]: i18n.hint ?? i18n.message }
            : ({} as Record<string, I18nText>),
      };
    }

    logger.error("settings_save_failed", {
      shop_domain: shop.shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false as const,
      message: { key: "settings.save_failed_body" } as I18nText,
      hint: undefined as I18nText | undefined,
      fieldErrors: {} as Record<string, I18nText>,
    };
  }
});

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t, language } = useAdminI18n();
  const tx = (text: I18nText | undefined) => (text ? t(text.key, text.params) : undefined);

  const [options, setOptions] = useState<DraftOption[]>(
    // Stored options may have a null emoji; the editor works in plain strings.
    data.options.map((option) => ({ ...option, emoji: option.emoji ?? "" })),
  );
  const [allowOther, setAllowOther] = useState(data.allowOther);
  const [questionText, setQuestionText] = useState(data.questionText);
  const [usedTranslatedDefaults, setUsedTranslatedDefaults] = useState(false);

  // Shown only to a non-English merchant whose survey is still the English
  // install defaults: their buyers would otherwise be asked in English.
  const showDefaultsOffer = data.offerTranslatedDefaults && language !== "en" && !usedTranslatedDefaults;

  const applyTranslatedDefaults = () => {
    setQuestionText(t("survey_defaults.question"));
    setOptions(
      DEFAULT_OPTIONS.map((option) => ({
        value: option.value,
        label: t(`survey_defaults.${option.value}`),
        emoji: option.emoji ?? "",
      })),
    );
    setUsedTranslatedDefaults(true);
  };

  const saving = fetcher.state !== "idle";
  const result = fetcher.data;

  // The Save button sits at the end of a long form, and on a phone the result
  // banner at the top is a screen away. A toast (rendered by the Shopify admin,
  // so it follows the merchant's theme) confirms the save where they are.
  useEffect(() => {
    if (!result) return;
    window.shopify?.toast?.show(
      result.ok ? t("settings.saved_title") : t("settings.save_failed_title"),
      { isError: !result.ok },
    );
    // Keyed on the result alone (not `t`) so each save shows exactly one toast.
  }, [result]);
  const fieldErrors = result?.fieldErrors ?? {};
  const countError = tx(fieldErrors.options);
  /** Accessible name for an option, even before the merchant has typed one. */
  const nameOf = (option: DraftOption, index: number) =>
    option.label || t("settings.default_option_label", { number: index + 1 });

  const move = (index: number, delta: number) => {
    setOptions((current) => {
      const target = index + delta;
      const from = current[index];
      const to = current[target];
      if (target < 0 || target >= current.length || !from || !to) return current;
      const next = [...current];
      next[index] = to;
      next[target] = from;
      return next;
    });
  };

  const updateOption = (index: number, patch: Partial<DraftOption>) => {
    setOptions((current) => current.map((option, i) => (i === index ? { ...option, ...patch } : option)));
  };

  const addOption = () => {
    setOptions((current) => [
      ...current,
      // A stable unique value keeps React keys correct while typing. The server
      // re-derives the real channel slug on save.
      { value: `draft-${crypto.randomUUID()}`, label: "", emoji: "" },
    ]);
  };

  const removeOption = (index: number) => {
    setOptions((current) => current.filter((_, i) => i !== index));
  };

  return (
    <s-stack gap="base">
      <s-section heading={t("settings.title")} subheading={t("settings.subtitle")} padding="none" />

      {result ? (
        <Banner
          tone={result.ok ? "success" : "critical"}
          heading={result.ok ? t("settings.saved_title") : t("settings.save_failed_title")}
        >
          <s-stack gap="small">
            <s-text>{tx(result.message)}</s-text>
            {result.hint ? <s-text>{tx(result.hint)}</s-text> : null}
          </s-stack>
        </Banner>
      ) : null}

      {showDefaultsOffer ? (
        <Banner tone="info" heading={t("settings.defaults_banner_title")}>
          <s-stack gap="small">
            <s-text>{t("settings.defaults_banner_body")}</s-text>
            <div>
              <s-button type="button" variant="primary" onClick={applyTranslatedDefaults}>
                {t("settings.defaults_banner_cta")}
              </s-button>
            </div>
          </s-stack>
        </Banner>
      ) : null}

      <fetcher.Form method="post">
        <s-stack gap="base">
          <Panel title={t("settings.question_panel_title")} description={t("settings.question_panel_description")}>
            <s-text-field
              label={t("settings.field_question")}
              name="questionText"
              value={questionText}
              onInput={(event) => setQuestionText(fieldValue(event))}
              details={t("settings.field_question_details")}
              error={tx(fieldErrors.questionText)}
              maxLength={MAX_QUESTION_LENGTH}
              required
            />
          </Panel>

          <Panel
            title={t("settings.options_panel_title")}
            description={t("settings.options_panel_description", { min: data.min, max: data.max })}
          >
            <s-stack gap="base">
              {countError ? (
                <Banner tone="critical" heading={t("settings.options_error_title")}>
                  <s-text>{countError}</s-text>
                </Banner>
              ) : null}

              {options.map((option, index) => (
                // One bordered card per option. The old single row (emoji,
                // label, three icon buttons) left the label field a few
                // characters wide on a phone. Now the emoji and label share a
                // row and the reorder/remove controls sit underneath, so the
                // label always gets the full width.
                <s-box key={option.value} padding="small" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-grid gridTemplateColumns="minmax(3.5rem, 4.5rem) minmax(0, 1fr)" gap="small" alignItems="end">
                      <s-text-field
                        label={t("settings.field_emoji")}
                        name="emoji"
                        value={option.emoji}
                        maxLength={EMOJI_MAX_LENGTH}
                        error={tx(fieldErrors[`options.${index}.emoji`])}
                        onInput={(event) => updateOption(index, { emoji: fieldValue(event) })}
                      />

                      <s-text-field
                        label={t("settings.field_option")}
                        name="label"
                        value={option.label}
                        maxLength={MAX_OPTION_LABEL_LENGTH}
                        required
                        error={tx(fieldErrors[`options.${index}.label`])}
                        onInput={(event) => updateOption(index, { label: fieldValue(event) })}
                      />
                    </s-grid>

                    {/* Reorder and remove are plain type="button" controls. They
                        must not submit the form — s-button has no name/value, so
                        intent is expressed through JS state instead. */}
                    <s-stack direction="inline" gap="small-200" justifyContent="end">
                      <s-button
                        type="button"
                        variant="tertiary"
                        icon="arrow-up"
                        disabled={index === 0}
                        accessibilityLabel={t("settings.move_up", { label: nameOf(option, index) })}
                        onClick={() => move(index, -1)}
                      />
                      <s-button
                        type="button"
                        variant="tertiary"
                        icon="arrow-down"
                        disabled={index === options.length - 1}
                        accessibilityLabel={t("settings.move_down", { label: nameOf(option, index) })}
                        onClick={() => move(index, 1)}
                      />
                      <s-button
                        type="button"
                        variant="tertiary"
                        tone="critical"
                        icon="delete"
                        disabled={options.length <= data.min}
                        accessibilityLabel={t("settings.remove_option", { label: nameOf(option, index) })}
                        onClick={() => removeOption(index)}
                      />
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}

              <s-button
                type="button"
                variant="secondary"
                icon="plus"
                onClick={addOption}
                disabled={options.length >= data.max}
                accessibilityLabel={
                  options.length >= data.max
                    ? t("settings.max_reached_aria", { max: data.max })
                    : t("settings.add_option_aria")
                }
              >
                {options.length >= data.max
                  ? t("settings.max_reached", { max: data.max })
                  : t("settings.add_option")}
              </s-button>
            </s-stack>
          </Panel>

          <Panel title={t("settings.other_panel_title")} description={t("settings.other_panel_description")}>
            <s-switch
              label={t("settings.other_switch")}
              name="allowOther"
              value="true"
              checked={allowOther}
              details={t("settings.other_switch_details")}
              onChange={(event) => setAllowOther(switchChecked(event))}
            />
          </Panel>

          <s-button type="submit" variant="primary" loading={saving}>
            {t("settings.save_button")}
          </s-button>
        </s-stack>
      </fetcher.Form>
    </s-stack>
  );
}