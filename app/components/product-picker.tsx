import { useState } from "react";

import type { TFn } from "~/components/survey-editor";

/**
 * "Only orders with these products" (F5), picked with Shopify's own product
 * picker so the merchant never types an id.
 *
 * The rule stores numeric product ids; titles are shown from the loader (read
 * with `read_products`) and from what the picker returned. A product deleted
 * from the store keeps its id here, labelled as no longer found, so the
 * merchant can remove it.
 */
export function ProductPicker({
  value,
  titles,
  onChange,
  max,
  t,
}: {
  value: readonly string[];
  /** Product id -> title, from the loader. */
  titles: Record<string, string>;
  onChange: (ids: string[]) => void;
  max: number;
  t: TFn;
}) {
  // Titles of products picked in this visit, before the next load reads them.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [unavailable, setUnavailable] = useState(false);
  const name = (id: string) => picked[id] ?? titles[id] ?? t("editor.products_missing", { id });

  const choose = async () => {
    const picker = typeof window !== "undefined" ? window.shopify?.resourcePicker : undefined;
    if (!picker) {
      setUnavailable(true);
      return;
    }
    try {
      const selection = await picker({
        type: "product",
        multiple: max,
        action: "select",
        selectionIds: value.map((id) => ({ id: `gid://shopify/Product/${id}` })),
        filter: { variants: false, draft: false, archived: false },
      });
      if (!selection) return;
      const next: Record<string, string> = {};
      const ids: string[] = [];
      for (const item of selection) {
        const id = item.id.split("/").pop() ?? "";
        if (!/^\d+$/.test(id)) continue;
        ids.push(id);
        if (item.title) next[id] = item.title;
      }
      setPicked({ ...picked, ...next });
      onChange(ids.slice(0, max));
    } catch {
      setUnavailable(true);
    }
  };

  return (
    <s-stack gap="small">
      <s-text type="strong">{t("editor.products")}</s-text>
      <s-text color="subdued">{t("editor.products_details")}</s-text>
      {value.length > 0 ? (
        <s-stack gap="small-200">
          {value.map((id) => (
            <s-stack key={id} direction="inline" gap="small" alignItems="center">
              <s-icon type="product" />
              <s-text>{name(id)}</s-text>
              <s-button
                type="button"
                variant="tertiary"
                icon="x"
                accessibilityLabel={t("editor.products_remove", { name: name(id) })}
                onClick={() => onChange(value.filter((other) => other !== id))}
              />
            </s-stack>
          ))}
        </s-stack>
      ) : (
        <s-text color="subdued" fontSize="small">
          {t("editor.products_none")}
        </s-text>
      )}
      <s-stack direction="inline" gap="small">
        <s-button type="button" icon="product" onClick={() => void choose()}>
          {value.length > 0 ? t("editor.products_change") : t("editor.products_choose")}
        </s-button>
        {value.length > 0 ? (
          <s-button type="button" variant="tertiary" onClick={() => onChange([])}>
            {t("editor.countries_clear")}
          </s-button>
        ) : null}
      </s-stack>
      {unavailable ? (
        <s-text tone="critical" fontSize="small">
          {t("editor.products_unavailable")}
        </s-text>
      ) : null}
    </s-stack>
  );
}
