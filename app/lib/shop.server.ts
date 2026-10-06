import type { PlanStatus } from "@prisma/client";

import { db, isRetryableDbError } from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { NotFoundError } from "~/lib/errors";
import { logger } from "~/lib/logger";
import { DEFAULT_OPTIONS, type SurveyOption } from "~/lib/settings";
import { withRetry } from "~/lib/retry.server";

/**
 * Shop repository. Owns encryption-at-rest of offline access tokens so no
 * other module has to know the ciphertext format.
 */

export type ShopRecord = {
  id: string;
  shopDomain: string;
  shopId: string;
  plan: string;
  planStatus: string;
  subscriptionGid: string | null;
  questionText: string;
  optionsJson: string;
  allowOther: boolean;
  /// Merchant's chosen admin UI language, or null if never chosen.
  language: string | null;
  checkoutSupported: boolean | null;
  installState: "installed" | "uninstalled";
};

export function defaultOptionsJson(): string {
  return JSON.stringify(DEFAULT_OPTIONS satisfies SurveyOption[]);
}

function retryDb<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(operation, {
    attempts: 3,
    baseDelayMs: 250,
    shouldRetry: isRetryableDbError,
  });
}

/** Upsert on shopDomain. Used by OAuth and by reinstall. */
export async function upsertShop(params: {
  shopDomain: string;
  shopId: string;
  accessToken?: string | null;
}): Promise<{ id: string }> {
  const { shopDomain, shopId } = params;
  const encrypted = params.accessToken ? encryptSecret(params.accessToken) : null;

  const row = await retryDb(() =>
    db.shop.upsert({
      where: { shopDomain },
      create: {
        shopDomain,
        shopId,
        optionsJson: defaultOptionsJson(),
        ...(encrypted
          ? {
              accessTokenEncrypted: encrypted.ciphertext,
              accessTokenIv: encrypted.iv,
              accessTokenTag: encrypted.tag,
            }
          : {}),
        installState: "installed",
        uninstalledAt: null,
      },
      update: {
        // provisionShop falls back to the domain when Shopify's identity lookup
        // fails; that placeholder must never replace a real GID already stored.
        ...(shopId.startsWith("gid://") ? { shopId } : {}),
        // Only overwrite the token when we actually have a new one. An
        // uninstalled shop being reinstalled gets a fresh one; a plain
        // re-auth without a token must not blank a valid stored token.
        ...(encrypted
          ? {
              accessTokenEncrypted: encrypted.ciphertext,
              accessTokenIv: encrypted.iv,
              accessTokenTag: encrypted.tag,
            }
          : {}),
        installState: "installed",
        uninstalledAt: null,
      },
      select: { id: true },
    }),
  );

  return row;
}

export async function findShopByDomain(shopDomain: string): Promise<ShopRecord | null> {
  return retryDb(() =>
    db.shop.findUnique({
      where: { shopDomain },
      select: {
        id: true,
        shopDomain: true,
        shopId: true,
        plan: true,
        planStatus: true,
        subscriptionGid: true,
        questionText: true,
        optionsJson: true,
        allowOther: true,
        language: true,
        checkoutSupported: true,
        installState: true,
      },
    }),
  );
}

/** Lookup for request paths where an unknown shop must 404. */
export async function requireShopByDomain(shopDomain: string): Promise<ShopRecord> {
  const shop = await findShopByDomain(shopDomain);
  if (!shop) throw new NotFoundError("Shop is not installed", { shop_domain: shopDomain });
  return shop;
}

/** Lookup by internal id. Returns null when the shop does not exist. */
export async function findShopById(shopId: string): Promise<ShopRecord | null> {
  return retryDb(() =>
    db.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        shopDomain: true,
        shopId: true,
        plan: true,
        planStatus: true,
        subscriptionGid: true,
        questionText: true,
        optionsJson: true,
        allowOther: true,
        language: true,
        checkoutSupported: true,
        installState: true,
      },
    }),
  );
}

/**
 * Decrypt the offline token. Returns null when absent or undecryptable —
 * callers must handle null by re-authenticating, not by crashing.
 */
export async function getAccessToken(internalShopId: string): Promise<string | null> {
  const row = await retryDb(() =>
    db.shop.findUnique({
      where: { id: internalShopId },
      select: { accessTokenEncrypted: true, accessTokenIv: true, accessTokenTag: true },
    }),
  );

  if (!row?.accessTokenEncrypted || !row.accessTokenIv || !row.accessTokenTag) return null;

  const token = decryptSecret({
    ciphertext: row.accessTokenEncrypted,
    iv: row.accessTokenIv,
    tag: row.accessTokenTag,
  });

  if (!token) {
    logger.error("access_token_decrypt_failed", { shop_id: internalShopId });
  }

  return token;
}

/** Erase the token on uninstall so no credential outlives the installation. */
export async function clearAccessToken(internalShopId: string): Promise<void> {
  await retryDb(() =>
    db.shop.update({
      where: { id: internalShopId },
      data: {
        accessTokenEncrypted: null,
        accessTokenIv: null,
        accessTokenTag: null,
        installState: "uninstalled",
        uninstalledAt: new Date(),
      },
    }),
  );
}

export async function updateSettings(
  internalShopId: string,
  data: { questionText: string; optionsJson: string; allowOther: boolean },
): Promise<void> {
  await retryDb(() =>
    db.shop.update({
      where: { id: internalShopId },
      data: {
        questionText: data.questionText,
        optionsJson: data.optionsJson,
        allowOther: data.allowOther,
      },
    }),
  );
}

/**
 * Record the merchant's language choice.
 *
 * A separate function rather than another field on `updateSettings` because the
 * two are written at completely different moments: `updateSettings` is the
 * survey form's Save button, whereas language is changed from a dropdown that
 * applies immediately. Sharing one function would mean a language click could
 * accidentally overwrite survey settings with stale form state.
 *
 * The value is validated by the caller against `isSupportedLanguage`; a null
 * clears the override and restores locale detection.
 */
export async function setLanguage(
  internalShopId: string,
  language: string | null,
): Promise<void> {
  await retryDb(() =>
    db.shop.update({
      where: { id: internalShopId },
      data: { language },
    }),
  );
}

export async function setPlan(
  internalShopId: string,
  data: {
    plan: "free" | "growth" | "scale";
    planStatus: PlanStatus;
    subscriptionGid: string | null;
    planDisplayName?: string | null;
  },
): Promise<void> {
  await retryDb(() =>
    db.shop.update({ where: { id: internalShopId }, data }),
  );
}

/**
 * Whether this order already has a response.
 *
 * The extension renders on both the Thank-you and Order-status pages, so this
 * is what stops a buyer being asked the same question twice. It is a separate
 * function rather than a call into responses.server.ts to keep the shop module
 * free of survey-response dependencies.
 */
export async function hasResponseFor(internalShopId: string, orderId: string): Promise<boolean> {
  const count = await retryDb(() =>
    db.surveyResponse.count({ where: { shopId: internalShopId, orderId } }),
  );
  return count > 0;
}

export async function setCheckoutSupport(internalShopId: string, supported: boolean | null): Promise<void> {
  await retryDb(() =>
    db.shop.update({
      where: { id: internalShopId },
      data: { checkoutSupported: supported, checkoutCheckedAt: new Date() },
    }),
  );
}
