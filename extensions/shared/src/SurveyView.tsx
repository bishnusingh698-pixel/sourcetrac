import type { ReactElement, ReactNode } from "react";
import type {
  BlockStackProps,
  ButtonProps,
  HeadingProps,
  InlineStackProps,
  PressableProps,
  TextFieldProps,
  TextProps,
  ViewProps,
} from "@shopify/ui-extensions/checkout";

import { OTHER_CHANNEL, surveyChoices } from "./survey-logic";

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
  Heading: Primitive;
  Pressable: Primitive;
  Text: Primitive;
  TextField: Primitive;
  View: Primitive;
  Button: Primitive;
}

/**
 * The injected primitives, re-typed against the real 2025.7 prop definitions.
 *
 * `Primitive` is `any` at the boundary (see above), which used to switch off
 * prop checking entirely. Every prop here was once wrong and nothing noticed:
 * `onClick` instead of `onPress` (so tapping an answer did nothing at all),
 * `borderRadius` instead of `cornerRadius`, background tokens and border widths
 * that do not exist in this API, and a CSS `style` object, which checkout
 * extensions cannot take. Casting to these signatures restores the checks
 * inside this file without touching the React 18/19 identity problem.
 */
type Typed<P> = (props: P & { children?: ReactNode }) => ReactElement | null;

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

export function SurveyView(props: SurveyViewProps) {
  const { phase, questionText, options, allowOther, selected, otherText, onSelect, onOtherTextChange, onSubmitOther, busy, t } =
    props;
  const BlockStack = props.BlockStack as Typed<BlockStackProps>;
  const InlineStack = props.InlineStack as Typed<InlineStackProps>;
  const Heading = props.Heading as Typed<HeadingProps>;
  const Pressable = props.Pressable as Typed<PressableProps>;
  const Text = props.Text as Typed<TextProps>;
  const TextField = props.TextField as Typed<TextFieldProps<string>>;
  const View = props.View as Typed<ViewProps>;
  const Button = props.Button as Typed<ButtonProps>;

  // Hidden collapses the block entirely; nothing is left on the page.
  if (phase === "hidden") return null;

  if (phase === "loading") {
    return (
      <Text appearance="subdued" size="small">
        {t("sourcetrac.loading", "Loading…")}
      </Text>
    );
  }

  if (phase === "done") {
    return <Text appearance="success">{t("sourcetrac.thanks", "Thanks!")}</Text>;
  }

  const choices = surveyChoices(options, allowOther, t("sourcetrac.other", "Other"));

  return (
    <BlockStack spacing="base">
      <Heading level={2}>{questionText}</Heading>

      {/* One full-width tile per answer, stacked. Most buyers reach the
          thank-you page on a phone, held one-handed right after paying, so
          every tile is a large target (`minBlockSize` 48 — above the 44px
          guideline) and a single tap submits. Colours, corner radius and font
          all come from the merchant's checkout branding: only theme tokens are
          used, never a fixed colour. */}
      <BlockStack spacing="tight">
        {choices.map((option) => {
          const isSelected = selected === option.value;
          return (
            <Pressable
              key={option.value}
              disabled={busy}
              onPress={() => onSelect(option.value)}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              border="base"
              borderWidth={isSelected ? "medium" : "base"}
              cornerRadius="base"
              background={isSelected ? "subdued" : "transparent"}
              padding="base"
              minBlockSize={48}
              blockAlignment="center"
            >
              <InlineStack spacing="tight" blockAlignment="center">
                {option.emoji ? <Text>{option.emoji}</Text> : null}
                <Text emphasis={isSelected ? "bold" : undefined}>{option.label}</Text>
              </InlineStack>
            </Pressable>
          );
        })}
      </BlockStack>

      {allowOther && selected === OTHER_CHANNEL ? (
        <View>
          <BlockStack spacing="tight">
            {/* Uncontrolled on purpose. `onChange` only fires when the field
                loses focus, so a controlled field left Submit disabled while
                the buyer was still typing with the phone keyboard open. Input
                is tracked with `onInput` and never written back as `value`. */}
            <TextField
              label={t("sourcetrac.otherLabel", "Tell us more (optional)")}
              onInput={onOtherTextChange}
              onChange={onOtherTextChange}
              maxLength={140}
              autocomplete={false}
            />
            <Button
              kind="primary"
              onPress={onSubmitOther}
              disabled={busy || otherText.trim().length === 0}
              loading={busy}
              loadingLabel={t("sourcetrac.sending", "Sending…")}
            >
              {t("sourcetrac.submit", "Submit")}
            </Button>
          </BlockStack>
        </View>
      ) : null}
    </BlockStack>
  );
}
