import type { ReactNode } from "react";

import type { TFunction } from "~/lib/i18n";
import type { BadgeTone } from "~/components/admin-ui";

/**
 * Confidence meter (T9), ideas to try (T12), by-product table (T8) and the
 * cross-question view (T14).
 *
 * These render the shapes built by `app/lib/insights.server.ts`. The server does
 * every calculation and every `Intl` format; the browser only draws. Money never
 * arrives here as minor units, and no statistic is ever shown raw — the
 * confidence meter is a plain-language label, never a margin of error.
 */

/** The success tone is reserved for "Reliable"; the weaker labels are neutral. */
const CONFIDENCE_TONE: Record<string, BadgeTone> = {
  too_early: "neutral",
  early_signal: "neutral",
  getting_clear: "neutral",
  reliable: "success",
};

export function ConfidenceBadge({
  level,
  n,
  t,
}: {
  level: string;
  n: number;
  t: TFunction;
}) {
  const tone = CONFIDENCE_TONE[level] ?? "neutral";
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-badge tone={tone}>{t(`confidence.${level}`)}</s-badge>
      <s-text color="subdued" fontSize="small">
        {t("confidence.answers", { count: n })}
      </s-text>
    </s-stack>
  );
}

export function ConfidenceHelp({ level, t }: { level: string; t: TFunction }) {
  return (
    <s-text color="subdued" fontSize="small">
      {t(`confidence.${level}_help`)}
    </s-text>
  );
}

/**
 * Ideas to try (T12). Rule-based suggestion cards, never AI, always worded as a
 * suggestion. Each card is dismissible (the caller stores the dismissal).
 */
export function IdeasList({
  ideas,
  t,
  onDismiss,
  emptyText,
}: {
  ideas: ReadonlyArray<{ key: string; text: string; basedOn: number }>;
  t: TFunction;
  onDismiss?: (key: string) => void;
  emptyText?: string;
}) {
  if (ideas.length === 0) {
    return emptyText ? <s-text color="subdued">{emptyText}</s-text> : null;
  }

  return (
    <s-stack gap="small">
      {ideas.map((idea) => (
        <s-box key={idea.key} padding="small" border="base" borderRadius="base">
          <s-stack gap="small">
            <s-stack direction="inline" justifyContent="space-between" gap="small" alignItems="start">
              <s-text>{idea.text}</s-text>
              {onDismiss ? (
                <s-button type="button" variant="tertiary" accessibilityLabel={t("ideas.dismiss")} onClick={() => onDismiss(idea.key)}>
                  ✕
                </s-button>
              ) : null}
            </s-stack>
            <s-text color="subdued" fontSize="small">
              {t("ideas.based_on", { count: idea.basedOn })}
            </s-text>
          </s-stack>
        </s-box>
      ))}
    </s-stack>
  );
}

/** A share bar relative to the busiest row, matching the Results breakdown. */
function ShareBar({ value, max }: { value: number; max: number }) {
  return <s-progress value={max > 0 ? Math.round((value / max) * 100) : 0} max={100} />;
}

/**
 * By-product table (T8). One row per product, the response count and the share
 * of the key answer, from the server's `buildProductBreakdown`.
 */
export function ProductTable({
  rows,
  t,
  topOptionLabel,
}: {
  rows: ReadonlyArray<{
    productId: string;
    productTitle: string;
    n: number;
    topOptionKey: string | null;
    topShare: number;
  }>;
  t: TFunction;
  topOptionLabel: (key: string | null) => string;
}) {
  if (rows.length === 0) {
    return <s-text color="subdued">{t("results.by_product_empty")}</s-text>;
  }
  const max = Math.max(1, ...rows.map((r) => r.topShare));
  return (
    <s-stack gap="small">
      {rows.map((row) => (
        <s-stack key={row.productId} gap="small-200">
          <s-stack direction="inline" justifyContent="space-between" gap="small">
            <s-text type="strong">{row.productTitle}</s-text>
            <s-text fontVariantNumeric="tabular-nums" color="subdued">
              {t("results.by_product_row", { count: row.n, label: topOptionLabel(row.topOptionKey), percent: Math.round(row.topShare * 100) })}
            </s-text>
          </s-stack>
          <ShareBar value={row.topShare} max={max} />
        </s-stack>
      ))}
    </s-stack>
  );
}

/**
 * Cross-question view (T14): rows = answers to A, columns = answers to B, each
 * cell a percentage of its row. Shown only with enough shared answers.
 */
export function CrossTabView({
  tab,
  t,
  label,
  rowLabel,
  colLabel,
  shares,
}: {
  tab: { rowKeys: string[]; colKeys: string[]; total: number; enough: boolean };
  t: TFunction;
  label: (id: string) => string;
  rowLabel: string;
  colLabel: string;
  shares: (rowKey: string) => Record<string, number>;
}) {
  if (!tab.enough) {
    return <s-text color="subdued">{t("results.cross_needs_more")}</s-text>;
  }

  return (
    <s-stack gap="small">
      <s-text color="subdued" fontSize="small">
        {t("results.cross_caption", { row: rowLabel, col: colLabel })}
      </s-text>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">{rowLabel}</s-table-header>
          {tab.colKeys.map((colKey) => (
            <s-table-header key={colKey}>{label(colKey)}</s-table-header>
          ))}
        </s-table-header-row>
        <s-table-body>
          {tab.rowKeys.map((rowKey) => {
            const rowShares = shares(rowKey);
            return (
              <s-table-row key={rowKey}>
                <s-table-cell>{label(rowKey)}</s-table-cell>
                {tab.colKeys.map((colKey) => (
                  <s-table-cell key={colKey}>
                    <s-text fontVariantNumeric="tabular-nums">
                      {t("results.cross_percent", { percent: Math.round((rowShares[colKey] ?? 0) * 100) })}
                    </s-text>
                  </s-table-cell>
                ))}
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

export function InsightHeading({ children }: { children: ReactNode }) {
  return <s-text type="strong">{children}</s-text>;
}
