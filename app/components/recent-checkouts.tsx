import type { TFn } from "~/components/survey-editor";
import type { ServeReason } from "~/lib/serve-log.server";

/**
 * "Recent checkouts": what the SourceTrac block was told on the last few
 * Thank-you page loads, and why nothing showed when nothing did. The answer to
 * "my survey doesn't show", which before this had no answer anywhere a
 * merchant could see.
 */

export type RecentCheckoutRow = {
  at: string;
  /** Formatted on the server in the store's zone, so hydration matches. */
  when: string;
  order: string | null;
  surveyName: string | null;
  reason: ServeReason;
  country: string | null;
};

/** Reasons that mean the merchant has something to change. */
const NEEDS_ACTION = new Set<ServeReason>([
  "none_live",
  "not_on_page",
  "pinned_not_live",
  "pinned_other_page",
  "customer_type_unknown",
  "country_unknown",
  "not_started",
  "ended",
  "max_responses",
]);

export function RecentCheckouts({ rows, t }: { rows: RecentCheckoutRow[]; t: TFn }) {
  return (
    <s-section heading={t("surveys.recent_title")}>
      <s-stack gap="base">
        <s-text color="subdued">{t("surveys.recent_help")}</s-text>
        {rows.length === 0 ? (
          <s-box padding="base" borderRadius="base" background="subdued">
            <s-text>{t("surveys.recent_empty")}</s-text>
          </s-box>
        ) : (
          <s-stack gap="small">
            {rows.map((row, index) => {
              const shown = row.reason === "shown";
              const tone = shown ? "success" : NEEDS_ACTION.has(row.reason) ? "warning" : "neutral";
              return (
                <s-box key={`${row.at}-${index}`} padding="small" border="base" borderRadius="base">
                  <s-stack gap="small-200">
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-badge tone={tone}>{shown ? t("surveys.recent_shown") : t("surveys.recent_hidden")}</s-badge>
                      <s-text type="strong">
                        {row.order ? t("surveys.recent_order", { order: row.order }) : t("surveys.recent_no_order")}
                      </s-text>
                      <s-text color="subdued" fontSize="small">
                        {row.when}
                      </s-text>
                    </s-stack>
                    <s-text>
                      {t(`surveys.reason_${row.reason}`, {
                        survey: row.surveyName ?? t("editor.untitled"),
                        country: row.country ?? "—",
                      })}
                    </s-text>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
