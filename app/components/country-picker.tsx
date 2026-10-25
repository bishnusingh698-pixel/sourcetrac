import { useMemo, useState } from "react";

import { Banner } from "~/components/admin-ui";
import { COUNTRY_CODES, isCountryCode } from "@shared/countries";
import type { TFn } from "~/components/survey-editor";

/**
 * "Only these countries", as a searchable, scrolling list of checkboxes.
 *
 * It replaced a free-text box of comma-separated codes: "USA", "UK" or
 * "United States" saved a rule no checkout could match, and the survey quietly
 * showed to nobody. Country names come from `Intl.DisplayNames` in the
 * merchant's language; the stored value is always the ISO code Shopify reports.
 * Plain HTML inputs, like the survey preview: 250 Polaris checkboxes inside a
 * scrolling box is heavy, and native inputs scroll and work with a keyboard.
 */
export function CountryPicker({
  value,
  onChange,
  language,
  error,
  t,
  label,
  details,
}: {
  value: readonly string[];
  onChange: (codes: string[]) => void;
  language: string;
  error?: string;
  t: TFn;
  /** Heading and help; the survey's own country rule by default. */
  label?: string;
  details?: string;
}) {
  const [query, setQuery] = useState("");

  const names = useMemo(() => {
    let display: Intl.DisplayNames | null = null;
    try {
      display = new Intl.DisplayNames([language, "en"], { type: "region" });
    } catch {
      display = null;
    }
    const collator = new Intl.Collator([language, "en"]);
    return COUNTRY_CODES.map((code) => ({ code, name: display?.of(code) ?? code })).sort((a, b) =>
      collator.compare(a.name, b.name),
    );
  }, [language]);

  const selected = new Set(value.filter(isCountryCode));
  const invalid = value.filter((code) => !isCountryCode(code));
  const needle = query.trim().toLowerCase();
  const shown = names
    .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle)
    // Picked countries first, so the selection is always in view.
    .sort((a, b) => Number(selected.has(b.code)) - Number(selected.has(a.code)));

  const toggle = (code: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(code);
    else next.delete(code);
    onChange(COUNTRY_CODES.filter((c) => next.has(c)));
  };

  const summary =
    selected.size === 0
      ? t("editor.countries_none")
      : t("editor.countries_selected", {
          list: names
            .filter((c) => selected.has(c.code))
            .map((c) => c.name)
            .join(", "),
        });

  return (
    <s-stack gap="small">
      <s-text type="strong">{label ?? t("editor.countries")}</s-text>
      <s-text color="subdued">{details ?? t("editor.countries_details")}</s-text>
      {invalid.length > 0 ? (
        <Banner tone="warning" heading={t("editor.countries_invalid", { codes: invalid.join(", ") })}>
          <s-button onClick={() => onChange([...selected])}>{t("editor.countries_remove_invalid")}</s-button>
        </Banner>
      ) : null}
      <s-search-field
        label={t("editor.countries_search")}
        labelAccessibilityVisibility="exclusive"
        placeholder={t("editor.countries_search")}
        value={query}
        onInput={(e: Event) => setQuery((e.currentTarget as { value?: string }).value ?? "")}
      />
      <div className="st-country-list" role="group" aria-label={t("editor.countries")}>
        {shown.length === 0 ? (
          <p className="st-country-empty">{t("editor.countries_no_match")}</p>
        ) : (
          shown.map((country) => (
            <label key={country.code} className="st-country-row">
              <input
                type="checkbox"
                checked={selected.has(country.code)}
                onChange={(e) => toggle(country.code, e.currentTarget.checked)}
              />
              <span>{country.name}</span>
              <span className="st-country-code">{country.code}</span>
            </label>
          ))
        )}
      </div>
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-text color="subdued" fontSize="small">
          {summary}
        </s-text>
        {selected.size > 0 ? (
          <s-button variant="tertiary" onClick={() => onChange([])}>
            {t("editor.countries_clear")}
          </s-button>
        ) : null}
      </s-stack>
      {error ? <s-text tone="critical">{error}</s-text> : null}
    </s-stack>
  );
}
