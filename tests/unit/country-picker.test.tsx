import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CountryPicker } from "~/components/country-picker";
import { createTranslator } from "~/lib/i18n";

const t = createTranslator("en");

describe("the country picker", () => {
  it("lists every country by name in a scrolling box, picked ones first", () => {
    const html = renderToStaticMarkup(<CountryPicker value={["GB"]} onChange={() => {}} language="en" t={t} />);
    expect(html).toContain('class="st-country-list"');
    expect(html).toContain("United States");
    expect(html.indexOf("United Kingdom")).toBeLessThan(html.indexOf("Afghanistan"));
    expect(html).toContain("Only in: United Kingdom");
    expect(html).not.toContain("editor.");
  });

  it("names the saved codes no buyer could ever match", () => {
    const html = renderToStaticMarkup(<CountryPicker value={["USA", "US"]} onChange={() => {}} language="de" t={createTranslator("de")} />);
    expect(html).toContain("USA");
    expect(html).toContain("Vereinigte Staaten");
  });
});
