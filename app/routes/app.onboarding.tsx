import { Link, useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { db } from "~/db.server";
import { findShopByDomain } from "~/lib/shop.server";
import { authenticate } from "~/shopify.server";

/**
 * First-run onboarding: a three-step checklist.
 *
 * A step is only reported as done when we can prove it from our own data. For
 * step 1 we deliberately do NOT claim to know whether the block is enabled in
 * the checkout editor: the Admin API exposes no such state, and guessing would
 * be worse than asking the merchant to confirm. Shopify sends no event when an
 * extension block is toggled.
 */

export const meta: MetaFunction = () => [{ title: "Get started — SourceTrac" }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findShopByDomain(session.shop);
  if (!shop) {
    throw new Response(null, { status: 302, headers: { Location: "/auth?redirect=/app/onboarding" } });
  }

  const [responseCount, orderCount] = await Promise.all([
    db.surveyResponse.count({ where: { shopId: shop.id } }),
    db.orderCache.count({ where: { shopId: shop.id } }),
  ]);

  return {
    shopDomain: shop.shopDomain,
    hasResponses: responseCount > 0,
    hasOrders: orderCount > 0,
    checkoutSupported: shop.checkoutSupported,
    hasOther: shop.allowOther,
  };
};

type Step = { title: string; body: string; done: boolean; action?: { label: string; href: string } };

export default function Onboarding() {
  const data = useLoaderData<typeof loader>();

  // The checkout editor URL is admin-only and needs the shop handle. Building it
  // here keeps the link correct per store rather than hardcoding a path.
  const editorUrl = `https://admin.shopify.com/store/${data.shopDomain.replace(/\.myshopify\.com$/, "")}/themes/current/editor`;

  const steps: Step[] = [
    {
      title: "Enable the survey in the checkout editor",
      body: data.hasOrders
        ? "We have received order data, so the survey can be shown to buyers."
        : "Add the SourceTrac block to your thank-you page and your order status page.",
      done: false,
      action: { label: "Open the checkout editor", href: editorUrl },
    },
    {
      title: "Pick your channels",
      body: data.hasOther
        ? "Your answer options are set, and buyers can type their own."
        : "Choose the 6 to 10 ways customers find you, and order them however you like.",
      done: false,
      action: { label: "Edit your channels", href: "/app/settings" },
    },
    {
      title: "See your first response",
      body: data.hasResponses
        ? "You have answers. The dashboard shows what each channel is worth."
        : "Place a test order, then answer the question on the thank-you page. It appears on your dashboard within a minute.",
      done: data.hasResponses,
      action: data.hasResponses ? { label: "View dashboard", href: "/app" } : undefined,
    },
  ];

  const complete = steps.filter((step) => step.done).length;

  return (
    <s-stack gap="base">
      <s-section heading="Get started" subheading="Three steps to your first attributed order." padding="none" />

      {data.checkoutSupported === false ? (
        <Banner tone="warning" heading="SourceTrac is not available on your Shopify plan">
          The survey appears on the thank-you and order status pages, which Shopify does not make
          available on the Starter plan. Upgrade your Shopify plan to start collecting answers.
          Everything else in SourceTrac is ready for when you do.
        </Banner>
      ) : null}

      <Panel title={`${complete} of ${steps.length} done`}>
        <s-stack gap="base">
          <s-progress value={complete} max={steps.length} accessibilityLabel={`${complete} of ${steps.length} steps complete`} />

          <s-ordered-list>
            {steps.map((step, index) => (
              <li key={step.title}>
                <s-stack gap="small">
                  <s-text type={step.done ? "strong" : "generic"}>
                    {index + 1}. {step.title}
                  </s-text>
                  {step.done ? <s-badge tone="success">Done</s-badge> : null}
                  <s-text color="subdued">{step.body}</s-text>
                  {step.action ? (
                    <div>
                      <s-link href={step.action.href}>{step.action.label}</s-link>
                    </div>
                  ) : null}
                </s-stack>
              </li>
            ))}
          </s-ordered-list>
        </s-stack>
      </Panel>

      <Banner tone="info" heading="Why step 1 asks you to confirm">
        <s-text>
          Shopify does not tell apps whether a checkout block is switched on, so we cannot tick this
          for you. If the survey is not appearing on your thank-you page, check that the SourceTrac
          block is added and visible there.
        </s-text>
      </Banner>
    </s-stack>
  );
}