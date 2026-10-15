import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

import { login } from "~/shopify.server";

/**
 * `/auth/login` — the library's login entry for a merchant who opens the app
 * outside the Shopify admin. `login()` redirects to Shopify's install/auth
 * flow when a shop domain is given and returns a typed error otherwise. Without
 * this route the path fell through to the `/auth/*` splat and answered 500.
 */

function errorText(result: { shop?: LoginErrorType } | undefined): string | null {
  if (result?.shop === LoginErrorType.MissingShop) return "Enter your store's myshopify.com domain.";
  if (result?.shop === LoginErrorType.InvalidShop) return "That is not a valid myshopify.com domain.";
  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // A request with no `shop` parameter is just the page being opened: no error yet.
  const hasShop = new URL(request.url).searchParams.has("shop");
  const result = await login(request);
  return { error: hasShop ? errorText(result) : null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return { error: errorText(await login(request)) };
};

export default function Login() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const error = actionData?.error ?? loaderData.error;

  return (
    <main style={{ maxWidth: 420, margin: "64px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>SourceTrac</h1>
      <Form method="post">
        <label htmlFor="shop">Store domain</label>
        <input id="shop" name="shop" type="text" placeholder="example.myshopify.com" autoComplete="on" />
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit">Log in</button>
      </Form>
    </main>
  );
}
