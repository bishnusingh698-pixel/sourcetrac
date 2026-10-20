import { vi } from "vitest";

/** A subscription as Shopify reports it. */
export type StubSubscription = { id: string; name: string; status: string; test?: boolean; currentPeriodEnd?: string | null };

/**
 * Stand in for Shopify's Admin API at `fetch`, answering the billing reads the
 * app makes: one subscription by id (`node`), the active subscriptions, and
 * whether the store is a development store. Returns the live list so a test
 * can change Shopify's state between notices.
 */
export function stubShopifyBilling(
  subscriptions: StubSubscription[],
  { developmentStore = false }: { developmentStore?: boolean } = {},
): StubSubscription[] {
  const state = [...subscriptions];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
      const full = (s: StubSubscription) => ({ test: false, currentPeriodEnd: null, ...s });
      let data: unknown;
      if (query.includes("partnerDevelopment")) {
        data = { shop: { plan: { publicDisplayName: "Basic", partnerDevelopment: developmentStore } } };
      } else if (query.includes("node(id:")) {
        const found = state.find((s) => s.id === variables.id);
        data = { node: found ? full(found) : null };
      } else {
        data = { appInstallation: { activeSubscriptions: state.filter((s) => s.status === "ACTIVE").map(full) } };
      }
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
  return state;
}
