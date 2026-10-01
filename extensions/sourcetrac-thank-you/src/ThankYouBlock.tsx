import { useRemoteSubscription } from "@remote-ui/react";
import {
  BlockStack,
  Button,
  InlineStack,
  Pressable,
  Text,
  TextField,
  useApi,
  useSessionToken,
  useTranslate,
  View,
} from "@shopify/ui-extensions-react/checkout";

import { SurveyView } from "../../shared/src/SurveyView";
import { createSurveyApi } from "../../shared/src/survey-logic";
import { useSurvey } from "../../shared/src/use-survey";

/** Must match APP_URL and this extension's `allowed_urls` in the TOML. */
const API_URL = process.env.API_URL ?? "https://sourcetrac.onrender.com";

/**
 * purchase.thank-you.block.render
 *
 * The order id comes from the `orderConfirmation` API, which this target
 * receives. No buyer input is read and nothing identifying is rendered: the only
 * data we ever receive from the buyer is the option they tapped.
 */
export default function ThankYouBlock() {
  // Typed against this target so `orderConfirmation` resolves. The
  // unparameterised hook returns the generic StandardApi, which lacks it.
  const api = useApi<"purchase.thank-you.block.render">();
  // `orderConfirmation` is a remote subscribable in this API version, not a
  // plain object, so `.value` does not exist on it. Unwrap it with the
  // subscription hook; it re-renders when the confirmation resolves.
  const { order } = useRemoteSubscription(api.orderConfirmation);
  const orderId = order?.id;

  const sessionToken = useSessionToken();
  const translate = useTranslate();

  const surveyApi = createSurveyApi(API_URL, {
    // `sessionToken.get()` re-mints when its cached JWT has expired, so a retry
    // after a long cold start never sends a stale token.
    getSessionToken: () => sessionToken.get(),
    translate,
  });

  const survey = useSurvey(orderId ?? "", "thank-you", surveyApi);

  if (!orderId) {
    // Without an order id there is nothing to attribute the answer to. Fail
    // silently rather than showing an error on a page the buyer just paid on.
    return null;
  }

  return (
    <SurveyView
      phase={survey.phase}
      questionText={survey.questionText}
      options={survey.options}
      allowOther={survey.allowOther}
      selected={survey.selected}
      otherText={survey.otherText}
      onSelect={survey.select}
      onOtherTextChange={survey.setOtherText}
      onSubmitOther={survey.submitOther}
      busy={survey.busy}
      t={survey.t}
      BlockStack={BlockStack}
      InlineStack={InlineStack}
      Pressable={Pressable}
      Text={Text}
      TextField={TextField}
      View={View}
      Button={Button}
    />
  );
}