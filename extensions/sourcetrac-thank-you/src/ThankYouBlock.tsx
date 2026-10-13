/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useMemo } from "preact/hooks";
import type { Api } from "@shopify/ui-extensions/purchase.thank-you.block.render";

import { MultiSurveyView } from "../../shared/src/MultiSurveyView";
import { MultiSurveyPreview } from "../../shared/src/MultiSurveyView";
import { createSurveyApi } from "../../shared/src/survey-logic";
import { useMultiSurvey } from "../../shared/src/use-multi-survey";

/** Must match the APP_URL the backend is reached on, and the host
 *  allowed by the Partner Dashboard network-access opt-in for this app. */
// A literal, not an environment variable: extensions run in a Web Worker where `process`
// is undefined, so reading it throws and the survey never renders.
const API_URL = "https://sourcetrac.onrender.com";

/**
 * purchase.thank-you.block.render
 *
 * With api_version 2026-07 the CLI's generated entry calls this default export
 * as `shopify.extend(target, (...args) => extension(...args))`, so it must be a
 * plain function that renders, not a component. The API is the `shopify`
 * global.
 */
export default async function extension() {
  render(<ThankYouBlock />, document.body);
}

const api = () => (globalThis as unknown as { shopify: Api }).shopify;

/**
 * The order id comes from the `orderConfirmation` signal. No buyer input is
 * read and nothing identifying is rendered: the only data we ever receive from
 * the buyer is the option they tapped.
 */
function ThankYouBlock() {
  const shopify = api();
  // Reading `.value` during render subscribes this component to the signal
  // (the `@shopify/ui-extensions/preact` import wires up Preact signals), so it
  // re-renders when the confirmation resolves.
  const orderId = shopify.orderConfirmation.value?.order?.id;

  const surveyApi = useMemo(
    () =>
      createSurveyApi(API_URL, {
        // `sessionToken.get()` re-mints when its cached JWT has expired, so a
        // retry after a long cold start never sends a stale token.
        getSessionToken: () => shopify.sessionToken.get(),
        translate: (key) => shopify.i18n.translate(key),
        getLocale: () => shopify.localization?.language?.value?.isoCode,
        // T7: read the buyer's selected payment method types so the server can
        // apply the "only orders paid on delivery" rule. Read lazily, not
        // captured: the selection can change and `fetchSurvey` is called after
        // the confirmation resolves. The array may be empty for some offsite
        // methods, which the server treats as "not a manual payment".
        getPaymentTypes: () =>
          (shopify.selectedPaymentOptions?.value ?? []).map((option) => option.type),
      }),
    [shopify],
  );

  // Set only inside the checkout editor, where there is no real order.
  const inEditor = shopify.extension.editor !== undefined;

  // No id in the editor, so no config fetch and nothing can be submitted
  // against a placeholder order.
  const survey = useMultiSurvey(inEditor ? "" : (orderId ?? ""), "thank_you", surveyApi);

  if (inEditor) {
    // Rendering nothing here left an empty block in the editor that looked broken.
    return <MultiSurveyPreview t={survey.t} />;
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
      onAnswer={survey.setAnswer}
      onNext={survey.next}
      onBack={survey.back}
      onSubmit={survey.submit}
      busy={survey.busy}
      t={survey.t}
    />
  );
}
