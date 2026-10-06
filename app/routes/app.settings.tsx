import { useState } from "react";
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
  EMOJI_MAX_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  parseSurveySettings,
  validateSurveySettings,
} from "~/lib/settings";
import { updateSettings } from "~/lib/shop.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

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

export const meta: MetaFunction = () => [{ title: "Settings — SourceTrac" }];

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

  return {
    questionText: shop.questionText,
    allowOther: shop.allowOther,
    options: parseSurveySettings(shop.optionsJson, {
      questionText: shop.questionText,
      options: [],
      allowOther: shop.allowOther,
    }).options,
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
      message: "Saved. Your question is live on the next checkout.",
      hint: undefined,
      fieldErrors: {} as Record<string, string>,
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      const field = error.fields.field;
      return {
        ok: false as const,
        message: error.message,
        hint: error.hint,
        fieldErrors:
          typeof field === "string" ? { [field]: error.hint ?? error.message } : ({} as Record<string, string>),
      };
    }

    logger.error("settings_save_failed", {
      shop_domain: shop.shopDomain,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false as const,
      message: "We could not save your changes. Your previous question is still live. Please try again.",
      hint: undefined,
      fieldErrors: {} as Record<string, string>,
    };
  }
});

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [options, setOptions] = useState<DraftOption[]>(
    // Stored options may have a null emoji; the editor works in plain strings.
    data.options.map((option) => ({ ...option, emoji: option.emoji ?? "" })),
  );
  const [allowOther, setAllowOther] = useState(data.allowOther);

  const saving = fetcher.state !== "idle";
  const result = fetcher.data;
  const fieldErrors = result?.fieldErrors ?? {};
  const countError = fieldErrors.options;

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
      <s-section
        heading="Settings"
        subheading="This is the question buyers see after they order."
        padding="none"
      />

      {result ? (
        <Banner tone={result.ok ? "success" : "critical"} heading={result.ok ? "Changes saved" : "Could not save"}>
          <s-stack gap="small">
            <s-text>{result.message}</s-text>
            {result.hint ? <s-text>{result.hint}</s-text> : null}
          </s-stack>
        </Banner>
      ) : null}

      <fetcher.Form method="post">
        <s-stack gap="base">
          <Panel title="Your question" description="Keep it short. One tap answers it.">
            <s-text-field
              label="Question"
              name="questionText"
              defaultValue={data.questionText}
              details="Shown at the top of the survey. Example: How did you hear about us?"
              error={fieldErrors.questionText}
              maxLength={MAX_QUESTION_LENGTH}
              required
            />
          </Panel>

          <Panel
            title="Answer options"
            description={`Between ${data.min} and ${data.max} options. Buyers tap one to answer.`}
          >
            <s-stack gap="base">
              {countError ? (
                <Banner tone="critical" heading="Fix your answer options">
                  <s-text>{countError}</s-text>
                </Banner>
              ) : null}

              {options.map((option, index) => (
                <s-grid
                  key={option.value}
                  gridTemplateColumns="auto 1fr auto"
                  gap="small"
                  alignItems="end"
                >
                  <s-text-field
                    label={index === 0 ? "Emoji" : "Emoji"}
                    name="emoji"
                    value={option.emoji}
                    maxLength={EMOJI_MAX_LENGTH}
                    // The emoji is decorative; the adjacent label carries the
                    // meaning, so it is not announced twice.
                    labelAccessibilityVisibility="exclusive"
                    onInput={(event) => updateOption(index, { emoji: fieldValue(event) })}
                  />

                  <s-text-field
                    label={index === 0 ? "Option" : "Option"}
                    name="label"
                    value={option.label}
                    maxLength={MAX_OPTION_LABEL_LENGTH}
                    required
                    error={fieldErrors[`options.${index}.label`]}
                    onInput={(event) => updateOption(index, { label: fieldValue(event) })}
                  />

                  {/* Reorder and remove are plain type="button" controls. They
                      must not submit the form — s-button has no name/value, so
                      intent is expressed through JS state instead. */}
                  <s-button-group>
                    <s-button
                      type="button"
                      variant="tertiary"
                      icon="arrow-up"
                      disabled={index === 0}
                      accessibilityLabel={`Move ${option.label || `option ${index + 1}`} up`}
                      onClick={() => move(index, -1)}
                    >
                      <s-text accessibilityVisibility="exclusive">Move up</s-text>
                    </s-button>
                    <s-button
                      type="button"
                      variant="tertiary"
                      icon="arrow-down"
                      disabled={index === options.length - 1}
                      accessibilityLabel={`Move ${option.label || `option ${index + 1}`} down`}
                      onClick={() => move(index, 1)}
                    >
                      <s-text accessibilityVisibility="exclusive">Move down</s-text>
                    </s-button>
                    <s-button
                      type="button"
                      variant="tertiary"
                      icon="delete"
                      disabled={options.length <= data.min}
                      accessibilityLabel={`Remove ${option.label || `option ${index + 1}`}`}
                      onClick={() => removeOption(index)}
                    >
                      <s-text accessibilityVisibility="exclusive">Remove</s-text>
                    </s-button>
                  </s-button-group>
                </s-grid>
              ))}

              <s-button
                type="button"
                variant="secondary"
                icon="plus"
                onClick={addOption}
                disabled={options.length >= data.max}
                accessibilityLabel={
                  options.length >= data.max
                    ? `Maximum of ${data.max} options reached`
                    : "Add an answer option"
                }
              >
                {options.length >= data.max ? `Maximum of ${data.max} options` : "Add option"}
              </s-button>
            </s-stack>
          </Panel>

          <Panel title="Other answers" description="Let buyers type their own answer instead.">
            <s-switch
              label="Allow a free-text answer"
              name="allowOther"
              value="true"
              checked={allowOther}
              details="Adds an “Other” choice where buyers can type their own. Useful while you are still discovering channels."
              onChange={(event) => setAllowOther(switchChecked(event))}
            />
          </Panel>

          <s-button type="submit" variant="primary" loading={saving}>
            Save changes
          </s-button>
        </s-stack>
      </fetcher.Form>
    </s-stack>
  );
}