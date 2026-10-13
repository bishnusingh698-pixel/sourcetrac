import type { ReactNode } from "react";

/**
 * S2: the realistic checkout page mock the Studio preview sits inside.
 *
 * Admin-only. Nothing here ships in the checkout extension. It uses a fixed
 * sample order ("#1001", "Alex") and the shop's own name, currency and first
 * product, so the merchant sees where the survey lands without any real customer
 * data ever entering the preview. Neutral styling, because the real checkout
 * inherits the store's fonts and colors.
 */

export type MockProduct = { title: string; imageUrl: string | null } | null;

export type PreviewPlacement = "thank_you" | "order_status" | "link" | "onsite";

export function CheckoutMock({
  placement,
  device,
  shopName,
  total,
  product,
  labels,
  children,
}: {
  placement: PreviewPlacement;
  device: "desktop" | "mobile";
  shopName: string;
  /** The order total, already formatted with the shop currency by the loader. */
  total: string;
  product: MockProduct;
  labels: {
    orderSummary: string;
    orderNumber: string;
    thankYou: string;
    confirmed: string;
    orderStatus: string;
    fulfillment: string;
    surveyLink: string;
    onSite: string;
  };
  children: ReactNode;
}) {
  const width = device === "mobile" ? "375px" : "640px";

  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <div style={{ maxWidth: width, marginInline: "auto" }}>
        <s-box padding="base" background="base" borderRadius="base" border="base">
          <s-stack gap="base">
            <s-text type="strong">{shopName}</s-text>

            {placement === "thank_you" || placement === "order_status" ? (
              <>
                <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
                  <s-text color="subdued">{labels.orderSummary}</s-text>
                  <s-text color="subdued" fontVariantNumeric="tabular-nums">
                    {total}
                  </s-text>
                </s-stack>

                {product ? (
                  <s-stack direction="inline" gap="small" alignItems="center">
                    {product.imageUrl ? (
                      <s-image src={product.imageUrl} alt="" inlineSize="fill" aspectRatio="1" />
                    ) : null}
                    <s-text color="subdued" fontSize="small">
                      {product.title}
                    </s-text>
                  </s-stack>
                ) : null}

                <s-heading>
                  {placement === "thank_you"
                    ? `${labels.thankYou} · ${labels.orderNumber}`
                    : `${labels.orderStatus} · ${labels.orderNumber}`}
                </s-heading>

                {placement === "order_status" ? (
                  <s-stack gap="small-200">
                    <s-divider />
                    <s-text color="subdued" fontSize="small">
                      {labels.fulfillment}
                    </s-text>
                  </s-stack>
                ) : null}
              </>
            ) : (
              <s-heading>{placement === "link" ? labels.surveyLink : labels.onSite}</s-heading>
            )}

            {children}

            {placement === "thank_you" ? (
              <s-stack gap="small-200">
                <s-divider />
                <s-text color="subdued" fontSize="small">
                  {labels.confirmed}
                </s-text>
              </s-stack>
            ) : null}
          </s-stack>
        </s-box>
      </div>
    </s-box>
  );
}
