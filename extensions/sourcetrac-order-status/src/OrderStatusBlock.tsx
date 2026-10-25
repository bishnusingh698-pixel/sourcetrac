/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useMemo } from "preact/hooks";
import type { Api } from "@shopify/ui-extensions/customer-account.order-status.block.render";

import { MultiSurveyView } from "../../shared/src/MultiSurveyView";
import { EditorPreview } from "../../shared/src/EditorPreview";
import { cleanSurveyId, createSurveyApi } from "../../shared/src/survey-logic";
import { useMultiSurvey } from "../../shared/src/use-multi-survey";

/** Must match the APP_URL the backend is reached on, and the host
 *  allowed by the Partner Dashboard network-access opt-in for this app. */
// A literal, not an environment variable: extensions run in a Web Worker where `process`
// is undefined, so reading it throws and the survey never renders.
const API_URL = "https://sourcetrac.onrender.com";

/**
 * customer-account.order-status.block.render
 *
 * With api_version 2026-07 the CLI's generated entry calls this default export
 * as `shopify.extend(target, (...args) => extension(...args))`, so it must be a
 * plain function that renders, not a component. The API is the `shopify`
 * global.
 */
export default async function extension() {
  render(<OrderStatusBlock />, document.body);
}

const api = () => (globalThis as unknown as { shopify: Api }).shopify;

/**
 * The order id comes from the `order` signal. A customer who answers here is
 * not asked again on the thank-you page and vice versa: the server's unique
 * constraint on (shop, order) decides, and the other page receives
 * `alreadyAnswered` and renders nothing. Nothing identifying is read or
 * rendered.
 */
function OrderStatusBlock() {
  const shopify = api();
  // Reading `.value` during render subscribes this component to the signal
  // (the `@shopify/ui-extensions/preact` import wires up Preact signals), so it
  // re-renders when the order resolves.
  const orderId = shopify.order.value?.id;

  const surveyApi = useMemo(
    () =>
      createSurveyApi(API_URL, {
        // `sessionToken.get()` re-mints when its cached JWT has expired, so a
        // retry after a long cold start never sends a stale token.
        getSessionToken: () => shopify.sessionToken.get(),
        translate: (key) => shopify.i18n.translate(key),
        getLocale: () => shopify.localization?.language?.value?.isoCode,
        // Country targeting. The order-status surface exposes the order's
        // country on `localization`, not on the order object.
        getCountry: () => shopify.localization?.country?.value?.isoCode,
        // The order total as the page shows it, for the order-value rule.
        getOrderTotal: () => shopify.cost?.totalAmount?.value,
      }),
    [shopify],
  );

  // Set only inside the checkout editor, where there is no real order.
  const inEditor = shopify.extension.editor !== undefined;

  // The block's "Survey ID" setting picks which survey it shows; empty means
  // the highest-priority live survey. Read during render so an edit in the
  // checkout editor re-renders the block. Absent on hosts without settings.
  let settingValue: unknown;
  try {
    settingValue = shopify.settings?.value?.survey_id;
  } catch {
    settingValue = undefined;
  }
  const surveyId = cleanSurveyId(settingValue);

  // The editor has no real order: it loads the merchant's survey for preview
  // instead, and nothing can be submitted against a placeholder order.
  const survey = useMultiSurvey(inEditor ? "" : (orderId ?? ""), "order_status", surveyApi, {
    surveyId,
    preview: inEditor,
  });

  if (inEditor) {
    return <EditorPreview survey={survey} />;
  }

  if (!orderId) {
    // Without an order id there is nothing to attribute the answer to. Fail
    // silently rather than showing an error on a page the buyer just paid on.
    return null;
  }

  return (
    <MultiSurveyView
      phase={survey.phase}
      title={survey.survey?.title ?? ""}
      intro={survey.survey?.intro ?? null}
      buttonLabel={survey.survey?.buttonLabel ?? ""}
      thankYouText={survey.survey?.thankYouText ?? ""}
      questions={survey.shown}
      answers={survey.answers}
      oneByOne={survey.oneByOne}
      step={survey.step}
      total={survey.total}
      complete={survey.complete}
      canAdvance={survey.canAdvance}
      onAnswer={survey.setAnswer}
      onNext={survey.next}
      onBack={survey.back}
      onSubmit={survey.submit}
      busy={survey.busy}
      t={survey.t}
      design={survey.survey?.design}
    />
  );
}
