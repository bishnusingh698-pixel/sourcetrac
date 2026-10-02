import type { CSSProperties } from "react";

import { OTHER_CHANNEL } from "./survey-logic";

/**
 * A checkout primitive, typed structurally rather than via React's
 * `ComponentType`.
 *
 * `@remote-ui/react` pins `@types/react` to `>=17 <19` while the admin app runs
 * React 19, so the same component resolves to two incompatible `ComponentClass`
 * identities and fails on `contextType`. These primitives are really remote-UI
 * host components, so `any` here reflects the truth of what they are: the props
 * we pass are still checked at each call site by that surface's own types.
 */
export type Primitive = any;

/**
 * The rendered survey, shared by both surfaces.
 *
 * Layout primitives are injected by the caller because the thank-you and
 * order-status extensions come from different packages
 * (`ui-extensions-react/checkout` vs `.../customer-account`) that do not share
 * an import path. Passing them in keeps one presentation while still rendering
 * with each surface's own components.
 */

export interface Components {
  BlockStack: Primitive;
  InlineStack: Primitive;
  Pressable: Primitive;
  Text: Primitive;
  TextField: Primitive;
  View: Primitive;
  Button: Primitive;
}

/**
 * Minimum 44px. Checkout tap-target guidance; anything smaller is unreliable on
 * a phone held one-handed immediately after payment.
 */
const TAP_TARGET_STYLE: CSSProperties = {
  minHeight: "44px",
  display: "flex",
  alignItems: "center",
};

export interface SurveyViewProps extends Components {
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

export function SurveyView({
  phase,
  questionText,
  options,
  allowOther,
  selected,
  otherText,
  onSelect,
  onOtherTextChange,
  onSubmitOther,
  busy,
  t,
  BlockStack,
  InlineStack,
  Pressable,
  Text,
  TextField,
  View,
  Button,
}: SurveyViewProps) {
  // Hidden and done collapse the block entirely; nothing is left on the page.
  if (phase === "hidden") return null;

  if (phase === "loading") {
    return (
      <BlockStack spacing="tight">
        <Text as="p" appearance="subdued">
          {t("sourcetrac.loading", "Loading…")}
        </Text>
      </BlockStack>
    );
  }

  if (phase === "done") {
    return (
      <BlockStack spacing="tight">
        <Text as="p" appearance="subdued">
          {t("sourcetrac.thanks", "Thanks!")}
        </Text>
      </BlockStack>
    );
  }

  const disabled = busy;

  return (
    <BlockStack spacing="base">
      <Text as="h2" appearance="strong">
        {questionText}
      </Text>

      <BlockStack spacing="tight">
        {options.map((option) => (
          <Pressable
            key={option.value}
            disabled={disabled}
            onClick={() => onSelect(option.value)}
            accessibilityRole="button"
            accessibilityLabel={option.label}
          >
            <View
              padding="base"
              borderRadius="base"
              borderWidth="025"
              borderColor="border"
              background={
                selected === option.value ? "bg-fill-secondary" : "surface"
              }
              style={TAP_TARGET_STYLE}
            >
              <InlineStack align="center" spacing="small">
                {option.emoji ? (
                  <Text as="span" ariaHidden="true">
                    {option.emoji}
                  </Text>
                ) : null}
                <Text as="span">{option.label}</Text>
              </InlineStack>
            </View>
          </Pressable>
        ))}
      </BlockStack>

      {allowOther && selected === OTHER_CHANNEL ? (
        <BlockStack spacing="tight">
          <TextField
            label={t("sourcetrac.otherLabel", "Tell us more (optional)")}
            value={otherText}
            onChange={onOtherTextChange}
            maxLength={140}
            autoComplete="off"
          />
          <InlineStack justify="end">
            <Button
              onClick={onSubmitOther}
              disabled={disabled || otherText.trim().length === 0}
              submit={busy}
            >
              {busy
                ? t("sourcetrac.sending", "Sending…")
                : t("sourcetrac.submit", "Submit")}
            </Button>
          </InlineStack>
        </BlockStack>
      ) : null}
    </BlockStack>
  );
}
