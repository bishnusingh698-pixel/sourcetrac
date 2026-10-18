/**
 * How a merchant's tag templates become the tags written to Shopify.
 *
 * Shared by the sync (app/lib/sync.server.ts), which writes the tags, and the
 * survey editor, which shows the merchant an example of exactly what will be
 * written. Before, the editor could not say that a tag without a colon is
 * written as `sourcetrac:<tag>`, so "vip" silently became "sourcetrac:vip".
 */

export const MAX_SYNC_TAGS = 4;
export const MAX_SYNC_TAG_LENGTH = 40;
/** Added in front of a tag the merchant typed without a `prefix:`. */
export const DEFAULT_TAG_PREFIX = "sourcetrac";

/** The merchant's tag templates as stored: trimmed, clamped, prefixed. */
export function normalizeTagTemplates(value: unknown, prefix = DEFAULT_TAG_PREFIX): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().slice(0, MAX_SYNC_TAG_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_SYNC_TAGS)
    .map((v) => (v.includes(":") ? v : `${prefix}:${v}`));
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Sanitise an order/customer tag before sending it to Shopify.
 *
 * A tag is built from the merchant's prefix plus the channel label, and the
 * channel label can be the buyer's free-text "Other" answer. A comma splits one
 * tag into several, so a shopper typing "a,b,c" would create arbitrary tags on
 * the order; control characters and length are clamped for the same reason.
 * Lower-cased and reduced to a safe character set, max 40 characters.
 */
export function sanitizeTag(raw: string): string {
  return raw
    .toLowerCase()
    // Drop control characters and anything that could break a tag (comma,
    // quotes, backslash). Space, letters, digits, dash, underscore, dot, colon
    // (the `prefix:channel` separator) and non-Latin letters survive.
    .replace(/[\u0000-\u001f\u007f,"'\\]/g, "")
    .replace(/[^\p{L}\p{N}\-_.: ]/gu, "")
    .trim()
    .slice(0, 40);
}

/**
 * A tag from a merchant template. Every `{channel}` is filled with the
 * channel's label, reduced to one safe segment (no `:`), so nothing typed by a
 * buyer can shape the tag; a template that needs a channel is skipped when the
 * buyer did not choose one, rather than writing `sourcetrac:`.
 */
export function fillTagTemplate(template: string, channel: string): string | null {
  if (!template.includes("{channel}")) return template;
  const value = sanitizeTag(channel).replace(/:/g, "-").trim();
  if (!value) return null;
  return template.replaceAll("{channel}", value);
}

/** The tags one answer produces from the merchant's templates. */
export function tagsForAnswer(templates: readonly string[], channel: string): string[] {
  return templates
    .map((tag) => fillTagTemplate(tag, channel))
    .filter((tag): tag is string => tag !== null)
    .map(sanitizeTag)
    .filter((tag) => tag.length > 0);
}
