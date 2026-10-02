import type { ReactNode } from "react";

/**
 * Small shared UI helpers for the embedded admin.
 *
 * Polaris ships as Web Components (`s-*` tags upgraded in place by the CDN
 * script in root.tsx), so there is no React component library to import. These
 * are thin wrappers that keep markup consistent and centralise presentation
 * rules that must not drift between screens.
 *
 * These elements do not accept a `style` attribute — styling is expressed only
 * through their documented attributes. Layout tweaks with no matching attribute
 * need a plain wrapper element.
 */

/** `s-banner` supports a narrower tone set than `ToneKeyword` (no `caution`). */
export type Tone = "info" | "success" | "warning" | "critical";

/**
 * `s-badge` and `s-progress` accept `neutral`, which `s-banner` does not. Kept
 * as its own type so a `neutral` badge can never reach a `Banner`.
 */
export type BadgeTone = "neutral" | Tone;

/**
 * Renders one entry per currency.
 *
 * Amounts arrive already formatted by `formatMoney` on the server, because
 * minor-unit maths and per-currency decimals (JPY has none, most have two) must
 * not be reimplemented in the browser.
 *
 * A multi-currency store produces one entry per currency. Showing the currency
 * is not decoration: blending them into one number would misstate the revenue.
 */
export function MoneyList({ amounts }: { amounts: ReadonlyArray<{ currency: string; text: string }> }) {
  if (amounts.length === 0) return <s-text color="subdued">—</s-text>;

  // A single-currency store is the overwhelmingly common case. Collapse to one
  // line so the metric tiles do not each grow a row per currency; only a
  // genuinely multi-currency store pays the vertical cost of the stack.
  const [only] = amounts;
  if (amounts.length === 1 && only) {
    return (
      <s-text fontVariantNumeric="tabular-nums" type="strong">
        {only.text}
      </s-text>
    );
  }

  return (
    <s-stack gap="small">
      {amounts.map((entry) => (
        <s-text key={entry.currency} fontVariantNumeric="tabular-nums">
          {entry.text}
        </s-text>
      ))}
    </s-stack>
  );
}

export function Metric({
  label,
  children,
  help,
  trend,
}: {
  label: string;
  children: ReactNode;
  help?: string;
  /**
   * Optional period-over-period delta. A `s-badge` carries it so the number and
   * its direction stay on one line at any width.
   */
  trend?: { text: string; tone: BadgeTone } | null;
}) {
  return (
    <s-box padding="small" border="base" borderRadius="base" background="subdued">
      <s-stack gap="small">
        {/* Label and delta share a row and push apart, so a tile without a delta
            looks identical to one that has it. The badge is always reserved via
            alignItems, never inserted, so the row below never shifts. */}
        <s-stack justifyContent="space-between" alignItems="center" gap="small">
          <s-text type="strong" fontSize="small">
            {label}
          </s-text>
          {trend ? <s-badge tone={trend.tone}>{trend.text}</s-badge> : null}
        </s-stack>
        <s-heading>{children}</s-heading>
        {help ? (
          <s-text color="subdued" fontSize="small">
            {help}
          </s-text>
        ) : null}
      </s-stack>
    </s-box>
  );
}

/** Section wrapper so every screen has the same heading/description rhythm. */
export function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <s-section heading={title} subheading={description} padding="none">
      {children}
    </s-section>
  );
}

export function Banner({
  tone,
  heading,
  children,
}: {
  tone: Tone;
  heading: string;
  children?: ReactNode;
}) {
  return (
    <s-banner tone={tone} heading={heading}>
      {children}
    </s-banner>
  );
}