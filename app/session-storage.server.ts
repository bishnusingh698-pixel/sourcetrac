import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import { db } from "~/db.server";

/**
 * Session storage for the embedded admin.
 *
 * Uses the Shopify-maintained Prisma adapter so offline tokens survive a
 * restart. The offline access token is additionally mirrored into the
 * encrypted `shops` table, because webhooks need it on a cold start when no
 * session storage row is loaded — see routes/webhooks.route.ts.
 */
export const sessionStorage = new PrismaSessionStorage(db as never);
