import { useEffect } from "react";
import { useNavigation } from "react-router";

/**
 * The loading state between admin pages: while a page's loader runs (a range
 * change, a tab, a link), the Shopify admin's own progress bar runs in its
 * header, through App Bridge's Loading API. Without it the old page sat there
 * with nothing to say a click had registered, sometimes for seconds while a
 * report or Shopify answered.
 *
 * Form submissions are left out: their buttons already show a spinner
 * (`loading`), and a second indicator for the same wait is noise. The bar is
 * always stopped when the shell unmounts, so it can never keep running.
 */
export function PageLoading() {
  const navigation = useNavigation();
  const loading = navigation.state === "loading" && !navigation.formMethod;
  useEffect(() => {
    window.shopify?.loading?.(loading);
  }, [loading]);
  useEffect(() => () => window.shopify?.loading?.(false), []);
  return null;
}
