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
} from "@shopify/ui-extensions-react/customer-account";

import { SurveyView } from "../../shared/src/SurveyView";
import { createSurveyApi } from "../../shared/src/survey-logic";
import { useSurvey } from "../../shared/src/use-survey";

/** Must match APP_URL and this extension's `allowed_urls` in the TOML. */
const API_URL = process.env.API_URL ?? "https://sourcetrac.onrender.com";

/**
 * customer-account.order-status.block.render
 *
 * A customer who answers here must not be asked again on the thank-you page and
 * vice versa. That is enforced server-side by a unique constraint on
 * (shop_id, order_id): whichever page they answer first wins, and the other page
 * receives `already_answered` and renders nothing.
 *
 * The order id comes from this target's `order` API. Nothing identifying about
 * the customer is read or rendered.
 */
export default function OrderStatusBlock() {
  const api = useApi<"customer-account.order-status.block.render">();
  // `order` is a remote subscribable in this API version, so `.value` does not
  // exist on it. Unwrap with the subscription hook; it re-renders on change.
  const order = useRemoteSubscription(api.order);
  const orderId = order?.id;

  const sessionToken = useSessionToken();
  const translate = useTranslate();

  const surveyApi = createSurveyApi(API_URL, {
    // `sessionToken.get()` re-mints when its cached JWT has expired, so a retry
    // after a long cold start never sends a stale token.
    getSessionToken: () => sessionToken.get(),
    translate,
  });

  const survey = useSurvey(orderId ?? "", "order-status", surveyApi);

  if (!orderId) {
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