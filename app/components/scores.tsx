import type { TFunction } from "~/lib/i18n";
import type { QuestionScore } from "~/lib/survey-analytics.server";

import { BigNumber } from "~/components/admin-ui";

/**
 * NPS and CSAT, drawn the same way on the Dashboard and on Results.
 *
 * A score only exists once a question has answers, so there is never a
 * fabricated 0: callers render their own empty state when the score is null.
 */

/** `+32`, `0`, `-15` in the merchant's locale. NPS is always shown signed. */
export function formatNps(score: number, locale: string): string {
  const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(score);
  return score > 0 ? `+${text}` : text;
}

/**
 * The headline score for an NPS, rating or satisfaction question, with what it
 * is made of. NPS shows the promoter / passive / detractor split; CSAT shows
 * the satisfied share and the average.
 */
export function ScoreBlock({ score, locale, t }: { score: QuestionScore; locale: string; t: TFunction }) {
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const percentOf = (count: number) => (score.total > 0 ? Math.round((count / score.total) * 100) : 0);

  if (score.kind === "nps") {
    const rows: Array<{ label: string; count: number; tone: "success" | "neutral" | "critical" }> = [
      { label: t("results.score_promoters"), count: score.promoters, tone: "success" },
      { label: t("results.score_passives"), count: score.passives, tone: "neutral" },
      { label: t("results.score_detractors"), count: score.detractors, tone: "critical" },
    ];
    return (
      <s-box padding="base" background="subdued" borderRadius="base">
        <s-stack gap="small">
          <s-stack gap="small-300">
            <s-text type="strong">{t("results.score_nps")}</s-text>
            <BigNumber>{formatNps(score.score, locale)}</BigNumber>
            <s-text color="subdued" fontSize="small">
              {t("results.score_nps_help")} {t("results.score_based_on", { count: score.total })}
            </s-text>
          </s-stack>
          {rows.map((row) => (
            <s-stack key={row.label} gap="small-300">
              <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="center">
                <s-text>{row.label}</s-text>
                <s-text fontVariantNumeric="tabular-nums">
                  {t("results.score_share", { percent: number(percentOf(row.count)), count: number(row.count) })}
                </s-text>
              </s-grid>
              <s-progress
                value={percentOf(row.count)}
                max={100}
                tone={row.tone}
                accessibilityLabel={`${row.label}: ${t("results.score_share_percent", { percent: number(percentOf(row.count)) })}`}
              />
            </s-stack>
          ))}
        </s-stack>
      </s-box>
    );
  }

  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack gap="small-300">
        <s-text type="strong">{t("results.score_csat")}</s-text>
        <BigNumber>{t("results.score_share_percent", { percent: number(score.percent) })}</BigNumber>
        <s-text>{t("results.score_average", { average: number(score.average, 1) })}</s-text>
        <s-progress
          value={score.percent}
          max={100}
          tone="success"
          accessibilityLabel={`${t("results.score_csat")}: ${t("results.score_share_percent", { percent: number(score.percent) })}`}
        />
        <s-text color="subdued" fontSize="small">
          {t("results.score_csat_help")} {t("results.score_based_on", { count: score.total })}
        </s-text>
      </s-stack>
    </s-box>
  );
}

/** The one-line value of a score, for a KPI tile: `+32` or `86%`. */
export function scoreValueText(score: QuestionScore, locale: string, t: TFunction): string {
  if (score.kind === "nps") return formatNps(score.score, locale);
  return t("results.score_share_percent", {
    percent: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(score.percent),
  });
}
