import { redirect, type LoaderFunctionArgs } from "react-router";

/**
 * `/` — the URL Shopify loads from `application_url` (with `?shop=&host=&embedded=`).
 * Without this route it 404s and the merchant sees an empty iframe. Forward to the
 * embedded admin with every query param intact so App Bridge gets `host`.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }

  return redirect("/privacy");
};
