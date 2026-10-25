import { slugifyChannel } from "~/lib/settings";
import { OTHER_CHANNEL_VALUE } from "@shared/survey-rules";
import { PRESET_TEMPLATE_KEY_PREFIX } from "@shared/templates/channel-presets";

/**
 * The readable channel key for one answer option, shared by every survey of a
 * shop: the legacy value of a migrated option, the template's option key, or
 * a slug of the label; any "Other" option is `other`.
 *
 * Option ids are unique per survey, so keying the channel report on them split
 * one real channel ("Instagram" in two surveys) into two rows with the
 * revenue divided between them. Order tags and Flow use the same key, so a
 * merchant matching on it sees the same name everywhere.
 */
export function readableChannelKey(params: {
  shopId: string;
  optionId: string;
  optionTemplateKey: string | null;
  questionTemplateKey: string | null;
  label: string;
  isOther?: boolean;
}): string {
  const { shopId, optionId, optionTemplateKey, questionTemplateKey, label } = params;
  if (optionId === OTHER_CHANNEL_VALUE || params.isOther) return OTHER_CHANNEL_VALUE;
  const migrated = `bf-option-${shopId}-`;
  if (optionId.startsWith(migrated)) return optionId.slice(migrated.length);
  // An answer loaded from a market preset (`shared/templates/channel-presets.ts`)
  // outside a template question.
  if (optionTemplateKey?.startsWith(PRESET_TEMPLATE_KEY_PREFIX)) {
    return optionTemplateKey.slice(PRESET_TEMPLATE_KEY_PREFIX.length);
  }
  if (optionTemplateKey && questionTemplateKey && optionTemplateKey.startsWith(`${questionTemplateKey}_`)) {
    return optionTemplateKey.slice(questionTemplateKey.length + 1);
  }
  return slugifyChannel(label, new Set());
}
