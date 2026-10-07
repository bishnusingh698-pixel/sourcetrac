import { useMemo } from "react";
import { useRemoteSubscription } from "@remote-ui/react";
import {
  BlockStack,
  Button,
  Heading,
  InlineStack,
  Pressable,
  Text,
  TextField,
  useApi,
  useSessionToken,
  useTranslate,
  View,
} from "@shopify/ui-extensions-react/checkout";

import { SurveyPreview, SurveyView } from "../../shared/src/SurveyView";
import { createSurveyApi } from "../../shared/src/survey-logic";
import { useSurvey } from "../../shared/src/use-survey";

/** Must match the APP_URL the backend is reached on, and the host
 *  allowed by the Partner Dashboard network-access opt-in for this app. */
// A literal, not an environment variable: extensions run in a Web Worker where `process`
// is undefined, so reading it throws and the survey never renders.
const API_URL = "https://sourcetrac.onrender.com";

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

  const surveyApi = useMemo(
    () =>
      createSurveyApi(API_URL, {
        // `sessionToken.get()` re-mints when its cached JWT has expired, so a
        // retry after a long cold start never sends a stale token. Safe to call
        // per attempt, so it is wrapped rather than captured once.
        getSessionToken: () => sessionToken.get(),
        translate,
      }),
    [sessionToken, translate],
  );

  // Set only inside the checkout editor, where there is no real order.
  const inEditor = api.extension.editor !== undefined;

  // No id in the editor, so no config fetch and nothing can be submitted
  // against a placeholder order.
  const survey = useSurvey(inEditor ? "" : (orderId ?? ""), "thank-you", surveyApi);

  const components = { BlockStack, Heading, InlineStack, Pressable, Text, TextField, View, Button };

  if (inEditor) {
    // Rendering nothing here left an empty block in the editor that looked broken.
    return <SurveyPreview t={survey.t} {...components} />;
  }

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
      {...components}
    />
  );
}