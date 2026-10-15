import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";

import { PageIntro } from "~/components/admin-ui";
import { DataCollectionDetails } from "~/components/data-notice";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { RECORD_RETENTION_DAYS, WEBHOOK_RETENTION_DAYS } from "~/lib/retention.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";

/**
 * Privacy and data: everything SourceTrac stores, why, where and for how long.
 *
 * The second layer of the notice at the foot of every page. Not in the admin
 * navigation (Shopify allows seven items and the six there are where merchants
 * work); every page links here instead.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "privacy.title");

export const handle = { titleKey: "privacy.title" };

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {
    retention: { months: Math.round(RECORD_RETENTION_DAYS / 30), webhookDays: WEBHOOK_RETENTION_DAYS },
  };
});

export default function Privacy() {
  const { retention } = useLoaderData<typeof loader>();
  const { t } = useAdminI18n();

  return (
    <s-stack gap="base">
      <PageIntro>{t("privacy.intro")}</PageIntro>
      <DataCollectionDetails t={t} retention={retention} />
    </s-stack>
  );
}
