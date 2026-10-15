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
export function MoneyList({
  amounts,
  size = "base",
  tone = "auto",
}: {
  amounts: ReadonlyArray<{ currency: string; text: string }>;
  /** `large` for a headline metric, `base` inside tables and lists. */
  size?: "base" | "large";
  tone?: "auto" | "success";
}) {
  if (amounts.length === 0) return <s-text color="subdued">—</s-text>;

  const fontSize = size === "large" ? "large-100" : "base";
  const fontWeight = size === "large" ? "bold" : "semibold";

  // A single-currency store is the overwhelmingly common case. Collapse to one
  // line so the metric tiles do not each grow a row per currency; only a
  // genuinely multi-currency store pays the vertical cost of the stack.
  const [only] = amounts;
  if (amounts.length === 1 && only) {
    return (
      <s-text fontVariantNumeric="tabular-nums" fontSize={fontSize} fontWeight={fontWeight} tone={tone}>
        {only.text}
      </s-text>
    );
  }

  return (
    <s-stack gap="small-200">
      {amounts.map((entry) => (
        <s-text key={entry.currency} fontVariantNumeric="tabular-nums" fontWeight={fontWeight} tone={tone}>
          {entry.text}
        </s-text>
      ))}
    </s-stack>
  );
}

/** A headline number, sized and weighted to match `MoneyList size="large"`. */
export function BigNumber({ children, tone = "auto" }: { children: ReactNode; tone?: "auto" | "success" }) {
  return (
    <s-text fontVariantNumeric="tabular-nums" fontSize="large-100" fontWeight="bold" tone={tone}>
      {children}
    </s-text>
  );
}

/**
 * One KPI tile: label, the number, and one line of context.
 *
 * With `href` the whole tile is a link (to the report behind the number), the
 * pattern Shopify's own app-home template uses for its metric cards.
 */
export function Metric({
  label,
  children,
  help,
  trend,
  href,
}: {
  label: string;
  children: ReactNode;
  help?: string;
  /**
   * Optional period-over-period delta. A `s-badge` carries it so the number and
   * its direction stay on one line at any width.
   */
  trend?: { text: string; tone: BadgeTone } | null;
  href?: string;
}) {
  const body = (
    <s-stack gap="small-200">
      {/* Label and delta share a row; the label takes what is left, so a long
          translated label wraps instead of pushing the badge out of the tile. */}
      <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
        <s-text color="subdued" fontSize="small" fontWeight="medium">
          {label}
        </s-text>
        {trend ? <s-badge tone={trend.tone}>{trend.text}</s-badge> : <span />}
      </s-grid>
      {children}
      {help ? (
        <s-text color="subdued" fontSize="small">
          {help}
        </s-text>
      ) : null}
    </s-stack>
  );

  if (href) {
    return (
      <s-clickable href={href} padding="base" border="base" borderRadius="large" background="base">
        {body}
      </s-clickable>
    );
  }
  return (
    <s-box padding="base" border="base" borderRadius="large" background="base">
      {body}
    </s-box>
  );
}

/**
 * The line under a page's title: what the page is for, and the page's own
 * actions on the right. The title itself is drawn by the shell's `<s-page>`
 * from the route's `handle.titleKey`. On a narrow admin the actions drop below
 * the text instead of squeezing it.
 */
export function PageIntro({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  if (!children && !actions) return null;
  return (
    <s-query-container>
      <s-grid
        gridTemplateColumns={actions ? "@container (inline-size > 560px) minmax(0, 1fr) auto, minmax(0, 1fr)" : "minmax(0, 1fr)"}
        gap="small"
        alignItems="center"
      >
        {children ? <s-text color="subdued">{children}</s-text> : <span />}
        {actions ? (
          <s-stack direction="inline" gap="small" alignItems="center">
            {actions}
          </s-stack>
        ) : null}
      </s-grid>
    </s-query-container>
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

/**
 * Collapsible section for advanced options, closed by default.
 *
 * Uses the native `<details>`/`<summary>` disclosure so it needs no component
 * library and stays keyboard accessible. The clickable target is the only
 * interactive element; its visible label is passed in already translated.
 */
export function AdvancedDisclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details style={{ marginBlockStart: "0.75rem" }}>
      <summary
        style={{
          cursor: "pointer",
          fontSize: "0.8125rem",
          fontWeight: 500,
          paddingBlock: "0.25rem",
        }}
      >
        {label}
      </summary>
      <div style={{ paddingBlockStart: "0.75rem" }}>{children}</div>
    </details>
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