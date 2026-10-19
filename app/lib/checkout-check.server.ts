import { db } from "~/db.server";
import { logger } from "~/lib/logger";
import { getCompiledConfig } from "~/lib/surveys.server";
import { lastPreviewLoad, recentServes } from "~/lib/serve-log.server";
import { hasAudienceRules } from "@shared/survey-config";
import { isOutdatedBlock } from "@shared/block-build";

/**
 * "Checkout check": everything the server can verify about why buyers would or
 * would not see a survey, without a test order.
 *
 * A merchant whose survey "just doesn't load" had no way to tell a broken
 * server from a block that is not in the checkout, an old block, or no survey
 * set for the page. Each line here answers one of those, from what the server
 * actually observed: block loads are only counted when the block itself asked
 * (a buyer's page or the checkout editor), never from the "It's already added"
 * button.
 */

export type BlockLoad = {
  /** ISO time of the newest load, buyer page or checkout editor. */
  at: string;
  outdated: boolean;
  where: "buyer" | "editor";
};

export type PageCheck = {
  placement: "thank_you" | "order_status";
  /** The survey buyers would be shown first on this page, before targeting. */
  survey: { name: string; audienceRules: boolean } | null;
  block: BlockLoad | null;
};

export type CheckoutCheck = {
  commit: string | null;
  database: { ok: true } | { ok: false; code: string };
  /** Live surveys the plan does not serve (beyond its live share). */
  planHidden: number;
  pages: PageCheck[];
};

async function checkDatabase(): Promise<CheckoutCheck["database"]> {
  try {
    // The newest columns and table; a deploy whose migration did not run
    // fails here instead of on every buyer's page.
    await db.$queryRaw`SELECT "autoPausedAt" FROM "Survey" LIMIT 1`;
    await db.$queryRaw`SELECT "orderId" FROM "OrderFact" LIMIT 1`;
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: string }).code ?? (error instanceof Error ? error.name : "unknown");
    logger.error("checkout_check_database_failed", {
      code,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code };
  }
}

function newestBlockLoad(shopId: string, placement: PageCheck["placement"]): BlockLoad | null {
  const buyer = recentServes(shopId).find((entry) => entry.placement === placement);
  const editor = lastPreviewLoad(shopId, placement);
  const candidates: BlockLoad[] = [];
  if (buyer) candidates.push({ at: buyer.at, outdated: isOutdatedBlock(buyer.blockBuild), where: "buyer" });
  if (editor) candidates.push({ at: editor.at, outdated: isOutdatedBlock(editor.blockBuild), where: "editor" });
  return candidates.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

export async function runCheckoutCheck(shopId: string, surveyNames: ReadonlyMap<string, string>): Promise<CheckoutCheck> {
  const database = await checkDatabase();
  let config: Awaited<ReturnType<typeof getCompiledConfig>> | null = null;
  let live = 0;
  if (database.ok) {
    [config, live] = await Promise.all([
      getCompiledConfig(shopId),
      db.survey.count({ where: { shopId, status: "active" } }),
    ]);
  }

  const pages = (["thank_you", "order_status"] as const).map((placement): PageCheck => {
    const top = config?.surveys.find((survey) => survey.placements.includes(placement)) ?? null;
    return {
      placement,
      survey: top
        ? {
            name: surveyNames.get(top.id) ?? top.title,
            audienceRules: hasAudienceRules(top.targeting, top.paymentManualOnly),
          }
        : null,
      block: newestBlockLoad(shopId, placement),
    };
  });

  return {
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
    database,
    planHidden: config ? Math.max(0, live - config.surveys.length) : 0,
    pages,
  };
}
