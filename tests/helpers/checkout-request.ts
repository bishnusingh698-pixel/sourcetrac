import crypto from "node:crypto";

/**
 * A checkout UI extension request as Shopify's runtime sends it: a session
 * token signed with the app secret (`dest` is the bare shop domain), a browser
 * User-Agent and a cross-origin Origin. Shared by the end-to-end tests.
 */
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

export function checkoutToken(shopDomain: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    dest: shopDomain,
    aud: process.env.SHOPIFY_API_KEY,
    exp: now + 300,
    nbf: now - 5,
    iat: now - 5,
    jti: crypto.randomUUID(),
  });
  const signature = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "").update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function checkoutRequest(shopDomain: string, path: string, init: RequestInit = {}): Request {
  return new Request(`https://sourcetrac.test${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${checkoutToken(shopDomain)}`,
      "Content-Type": "application/json",
      Origin: "https://extensions.shopifycdn.com",
      "User-Agent": UA,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** Call a route handler; a thrown Response (an auth refusal) is returned. */
export async function callRoute(handler: (args: { request: Request }) => Promise<Response>, req: Request): Promise<Response> {
  try {
    return await handler({ request: req });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}
