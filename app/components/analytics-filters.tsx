import { useSearchParams } from "react-router";

import type { TFunction } from "~/lib/i18n";
import { countryName } from "~/components/country-select";

/**
 * "Buyers in" (F6): narrow Analytics to one checkout country. The list holds
 * only countries buyers have answered from, busiest first, with their answer
 * counts, so the merchant never picks a country with nothing in it.
 *
 * Changing it rewrites `?country=` and keeps the other filters (range,
 * survey), so the page reloads its numbers through its own loader.
 */
export function CountryFilter({
  countries,
  value,
  language,
  t,
}: {
  countries: ReadonlyArray<{ code: string; count: number }>;
  value: string | null;
  language: string;
  t: TFunction;
}) {
  const [params, setParams] = useSearchParams();
  if (countries.length === 0 && !value) return null;
  const options = value && !countries.some((c) => c.code === value) ? [{ code: value, count: 0 }, ...countries] : countries;

  return (
    <s-select
      label={t("analytics.country_filter")}
      value={value ?? ""}
      onChange={(event: Event) => {
        const code = (event.currentTarget as { value?: string }).value ?? "";
        const next = new URLSearchParams(params);
        if (code) next.set("country", code);
        else next.delete("country");
        next.delete("page");
        setParams(next, { preventScrollReset: true });
      }}
    >
      <s-option value="">{t("analytics.all_countries")}</s-option>
      {options.map((country) => (
        <s-option key={country.code} value={country.code}>
          {t("analytics.country_option", { country: countryName(country.code, language), count: country.count })}
        </s-option>
      ))}
    </s-select>
  );
}

/** One line under a report: which days and which buyers the numbers cover. */
export function ReportScope({
  timeZone,
  country,
  language,
  t,
}: {
  timeZone: string;
  country: string | null;
  language: string;
  t: TFunction;
}) {
  return (
    <s-text color="subdued" fontSize="small">
      {t("analytics.zone_note", { zone: timeZone })}
      {country ? ` ${t("analytics.country_note", { country: countryName(country, language) })}` : ""}
    </s-text>
  );
}
