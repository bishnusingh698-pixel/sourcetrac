import { useMemo, useState } from "react";

import { COUNTRY_CODES } from "@shared/countries";

/**
 * Pick one country from a searchable, scrolling list.
 *
 * The single-choice sibling of `CountryPicker`: the same native rows (250
 * Polaris controls in a scrolling box are heavy; native inputs scroll and work
 * with a keyboard), names from `Intl.DisplayNames` in the merchant's language,
 * the ISO code beside each, and the chosen country kept at the top.
 */
export function CountrySelect({
  value,
  onChange,
  language,
  label,
  searchLabel,
  noMatch,
}: {
  value: string | null;
  onChange: (code: string) => void;
  language: string;
  label: string;
  searchLabel: string;
  noMatch: string;
}) {
  const [query, setQuery] = useState("");
  const names = useMemo(() => countryNames(language), [language]);
  const needle = query.trim().toLowerCase();
  const shown = names
    .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle)
    .sort((a, b) => Number(b.code === value) - Number(a.code === value));

  return (
    <s-stack gap="small">
      <s-search-field
        label={searchLabel}
        labelAccessibilityVisibility="exclusive"
        placeholder={searchLabel}
        value={query}
        onInput={(e: Event) => setQuery((e.currentTarget as { value?: string }).value ?? "")}
      />
      <div className="st-country-list" role="radiogroup" aria-label={label}>
        {shown.length === 0 ? (
          <p className="st-country-empty">{noMatch}</p>
        ) : (
          shown.map((country) => (
            <label key={country.code} className="st-country-row">
              <input
                type="radio"
                name="st-country-select"
                checked={country.code === value}
                onChange={() => onChange(country.code)}
              />
              <span>{country.name}</span>
              <span className="st-country-code">{country.code}</span>
            </label>
          ))
        )}
      </div>
    </s-stack>
  );
}

/** Every country with its name in `language`, sorted by name. */
export function countryNames(language: string): Array<{ code: string; name: string }> {
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
}

/** One country's name in `language`, or its code. */
export function countryName(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language, "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
