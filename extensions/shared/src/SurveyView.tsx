/** @jsxImportSource preact */
import { OTHER_CHANNEL, surveyChoices } from "./survey-logic";

/**
 * The rendered survey, shared by both surfaces.
 *
 * Written with Polaris web components (`s-stack`, `s-clickable`, ...), which
 * the 2025-10+ extension runtime provides on both the thank-you and the
 * order-status page, so one view serves both without injected primitives.
 *
 * Why Preact and not React: with `api_version` 2025-10 or later the Shopify CLI
 * builds the entry as `shopify.extend(target, (...args) => Default(...args))`,
 * i.e. it calls the module's default export as a plain function. The old
 * React/remote-ui binding expected `reactExtension(...)` instead, and its
 * reconciler (react-reconciler 0.29) crashes on the app's React 19. Either
 * alone meant the block rendered nothing, in the editor and on live orders.
 */

export interface SurveyViewProps {
  phase: "loading" | "asking" | "sending" | "done" | "hidden";
  questionText: string;
  options: { value: string; label: string; emoji: string | null }[];
  allowOther: boolean;
  selected: string | null;
  otherText: string;
  onSelect: (value: string) => void;
  onOtherTextChange: (value: string) => void;
  onSubmitOther: () => void;
  busy: boolean;
  t: (key: string, fallback: string) => string;
}

/** `currentTarget.value` of a field event, without trusting its shape. */
function fieldValue(event: { currentTarget: unknown }): string {
  const value = (event.currentTarget as { value?: unknown } | null)?.value;
  return typeof value === "string" ? value : "";
}

export function SurveyView(props: SurveyViewProps) {
  const { phase, questionText, options, allowOther, selected, otherText, onSelect, onOtherTextChange, onSubmitOther, busy, t } =
    props;

  // Hidden collapses the block entirely; nothing is left on the page.
  if (phase === "hidden") return null;

  if (phase === "loading") {
    return (
      <s-text color="subdued" type="small">
        {t("sourcetrac.loading", "Loading…")}
      </s-text>
    );
  }

  if (phase === "done") {
    return <s-text tone="success">{t("sourcetrac.thanks", "Thanks!")}</s-text>;
  }

  const choices = surveyChoices(options, allowOther, t("sourcetrac.other", "Other"));

  return (
    <s-stack gap="base">
      <s-heading>{questionText}</s-heading>

      {/* One full-width tile per answer, stacked. Most buyers reach the
          thank-you page on a phone, held one-handed right after paying, so
          every tile is a large target and a single tap submits. Colours,
          corner radius and font all come from the merchant's checkout
          branding: only theme tokens are used, never a fixed colour. */}
      <s-stack gap="small-200">
        {choices.map((option) => {
          const isSelected = selected === option.value;
          return (
            <s-clickable
              key={option.value}
              disabled={busy}
              onClick={() => onSelect(option.value)}
              accessibilityLabel={option.label}
              border="base"
              borderRadius="base"
              background={isSelected ? "subdued" : "transparent"}
              padding="base"
            >
              <s-stack direction="inline" gap="small-200" alignItems="center">
                {option.emoji ? <s-text>{option.emoji}</s-text> : null}
                <s-text type={isSelected ? "strong" : "generic"}>{option.label}</s-text>
              </s-stack>
            </s-clickable>
          );
        })}
      </s-stack>

      {allowOther && selected === OTHER_CHANNEL ? (
        <s-stack gap="small-200">
          {/* Uncontrolled on purpose: input is tracked with `onInput` and
              never written back as `value`, so typing with the phone
              keyboard open is never interrupted by a re-render. */}
          <s-text-field
            label={t("sourcetrac.otherLabel", "Tell us more")}
            onInput={(event) => onOtherTextChange(fieldValue(event))}
            onChange={(event) => onOtherTextChange(fieldValue(event))}
            maxLength={140}
          />
          <s-button
            variant="primary"
            onClick={onSubmitOther}
            disabled={busy || otherText.trim().length === 0}
            loading={busy}
          >
            {t("sourcetrac.submit", "Submit")}
          </s-button>
        </s-stack>
      ) : null}
    </s-stack>
  );
}

/**
 * What the block shows inside the checkout editor.
 *
 * The editor has no real order, so the live survey has nothing to attribute an
 * answer to and rendered nothing at all: a merchant who added the block saw it
 * appear empty and reasonably concluded it was broken. This shows sample
 * answers instead, with nothing wired to submit, so a click in the editor
 * never writes a response against a placeholder order.
 */
export function SurveyPreview({ t }: { t: (key: string, fallback: string) => string }) {
  const options = [
    { value: "instagram", label: "Instagram", emoji: null },
    { value: "google", label: t("sourcetrac.previewGoogle", "Google search"), emoji: null },
    { value: "friend-or-family", label: t("sourcetrac.previewFriend", "Friend or family"), emoji: null },
  ];

  return (
    <s-stack gap="small-200">
      <SurveyView
        phase="asking"
        questionText={t("sourcetrac.previewQuestion", "How did you hear about us?")}
        options={options}
        allowOther
        selected={null}
        otherText=""
        onSelect={() => undefined}
        onOtherTextChange={() => undefined}
        onSubmitOther={() => undefined}
        busy={false}
        t={t}
      />
      <s-text color="subdued" type="small">
        {t(
          "sourcetrac.previewNote",
          "Preview. Buyers see the question and answers you set in the SourceTrac app.",
        )}
      </s-text>
    </s-stack>
  );
}
