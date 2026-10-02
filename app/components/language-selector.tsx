import { useId, useState } from "react";
import { useFetcher } from "react-router";

import { createTranslator } from "~/lib/i18n";

// Flag SVGs imported from the `flag-icons` package rather than a CDN.
//
// Two reasons. A CDN request from inside the Shopify admin iframe adds a
// third-party round trip on the first-run screen and leaks the merchant's shop
// domain to that third party. Vite hashes and bundles these at build time, so
// they are same-origin, cached with the app, and cannot break if a CDN does.
//
// Emoji flags are explicitly not an option: Windows and some Linux desktops
// render them as the two-letter code ("DE") rather than a flag.
import flagUs from "flag-icons/flags/4x3/us.svg";
import flagDe from "flag-icons/flags/4x3/de.svg";
import flagFr from "flag-icons/flags/4x3/fr.svg";
import flagMx from "flag-icons/flags/4x3/mx.svg";
import flagBr from "flag-icons/flags/4x3/br.svg";
import flagCn from "flag-icons/flags/4x3/cn.svg";
import flagJp from "flag-icons/flags/4x3/jp.svg";
import flagIt from "flag-icons/flags/4x3/it.svg";
import flagNl from "flag-icons/flags/4x3/nl.svg";
import flagSe from "flag-icons/flags/4x3/se.svg";

import { LANGUAGES, type Language, type LanguageCode } from "~/lib/i18n/languages";

/**
 * Flag image per language code.
 *
 * Language is not country: English maps to the US, Spanish to Mexico and
 * Portuguese to Brazil because those are the largest Shopify merchant markets
 * for each language, so a merchant scanning the list recognises their own.
 */
const FLAGS: Record<LanguageCode, string> = {
  en: flagUs,
  de: flagDe,
  fr: flagFr,
  es: flagMx,
  "pt-BR": flagBr,
  "zh-CN": flagCn,
  ja: flagJp,
  it: flagIt,
  nl: flagNl,
  sv: flagSe,
};

/**
 * Long-translation wrapping, inlined.
 *
 * `s-text` accepts neither `class` nor `className` in its TypeScript definition,
 * so this cannot live in a stylesheet keyed by class name.
 */
const WRAP: React.CSSProperties = {
  overflowWrap: "anywhere",
  wordBreak: "normal",
  lineBreak: "auto",
};

/**
 * Pass `className`/`style` through to a Polaris custom element.
 *
 * `@shopify/polaris-types` declares only `key`, `ref` and `slot` on `s-*`
 * elements, because Polaris owns their styling. The real custom elements are
 * ordinary DOM nodes and React forwards `class` and `style` to them at runtime,
 * so the restriction is narrower than the platform.
 *
 * This is needed for exactly one thing: putting a flag image inside an
 * `s-option`, which renders its children as plain text and so cannot host an
 * element. Confining the cast to this helper keeps the escape hatch visible and
 * greppable, instead of scattering `as any` through the component — and it is
 * spread as a variable, which is what avoids the excess-property check.
 *
 * Nothing here overrides a colour or a Polaris spacing token: the only values
 * passed are a background image and text wrapping, so a merchant's admin theme
 * and dark mode are unaffected.
 */
function passthrough<T>(props: T): T {
  return props;
}

/**
 * Flag as a background image on a Polaris element.
 *
 * Both the collapsed select and each option derive from the same `FLAGS` record,
 * so the open list and the closed control can never show different flags.
 */
function flagStyle(flag: string): React.CSSProperties {
  return {
    backgroundImage: `url("${flag}")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "left 0.125rem center",
    backgroundSize: "1.125rem auto",
    paddingInlineStart: "1.75rem",
  };
}

export type LanguageSelectorLabels = {
  title: string;
  body: string;
  confirm: string;
  detected: string;
  change: string;
  current: string;
};

export type LanguageSelectorProps = {
  /** The language currently in effect. */
  value: LanguageCode;
  /**
   * Whether the current value came from detecting Shopify's admin locale rather
   * than an explicit choice. Only the dialog shows a hint for it.
   */
  detected?: boolean;
  variant?: "dialog" | "inline";
  labels: LanguageSelectorLabels;
  onSelect: (code: LanguageCode) => void;
  disabled?: boolean;
};

/**
 * Language picker.
 *
 * Two presentations, one source of truth (`LANGUAGES`):
 *
 *  - `dialog` for first run: a radio group of full-width rows, each with a real
 *    flag element, so all ten languages are visible at once. A dropdown would
 *    hide nine of them behind a control the merchant has no reason to open, and
 *    seeing their own language in the list is what makes them install.
 *  - `inline` for Settings: a compact Polaris `s-select`.
 *
 * ## Why a radio group and not `<s-select>` in the dialog
 *
 * `s-option` renders its children as plain text, so a flag element placed inside
 * one is not rendered — the option shows nothing or a fallback glyph. The
 * dialog therefore uses `s-clickable` rows, which accept arbitrary markup, and
 * only the compact inline variant uses `s-select` (there the flag is a CSS
 * background on the option and on the collapsed value, both derived from the
 * same `FLAGS` record so they cannot drift).
 */
export function LanguageSelector({
  value,
  detected = false,
  variant = "inline",
  labels,
  onSelect,
  disabled = false,
}: LanguageSelectorProps) {
  const [pending, setPending] = useState<LanguageCode>(value);
  const groupName = useId();
  const titleId = useId();

  if (variant === "inline") {
    return (
      <s-stack gap="small">
        <s-select
          {...passthrough({
            label: labels.change,
            value: pending,
            disabled,
            style: flagStyle(FLAGS[pending]),
          })}
          onChange={(event) => {
            const next = (event.currentTarget as { value?: unknown }).value;
            if (typeof next === "string" && next !== pending) {
              setPending(next as LanguageCode);
              onSelect(next as LanguageCode);
            }
          }}
        >
          {LANGUAGES.map((language) => (
            <s-option
              {...passthrough({
                key: language.code,
                value: language.code,
                selected: pending === language.code,
                style: flagStyle(FLAGS[language.code]),
              })}
            >
              {language.nativeName}
            </s-option>
          ))}
        </s-select>
        {/* Announced when the language changes, so a screen-reader user is told
            the app re-rendered rather than left in silence. `s-text` has no
            `role` attribute, so the live region is a plain element. */}
        <div role="status" aria-live="polite" className="st-visually-hidden">
          {labels.current.replace("{{name}}", endonym(pending))}
        </div>
      </s-stack>
    );
  }

  return (
    <s-box background="subdued" border="base" borderRadius="large" padding="large">
      <s-stack gap="base">
        <s-stack gap="small">
          <s-heading fontSize="large" id={titleId}>
            {labels.title}
          </s-heading>
          <s-text>{labels.body}</s-text>
        </s-stack>

        {/*
          A real `radiogroup` of native radio inputs, visually restyled rather
          than replaced. Native radios give arrow-key navigation, a single tab
          stop, and correct "2 of 10" announcement for free — a grid of buttons
          would need all of that reimplemented by hand and would get it wrong.
        */}
        <div role="radiogroup" aria-labelledby={titleId} className="st-lang-grid">
          {LANGUAGES.map((language) => {
            const selected = language.code === pending;
            return (
              <s-clickable
                key={language.code}
                // `s-clickable` is not a form control, so the input below is the
                // real accessible element and this is only its visual surface.
                background={selected ? "strong" : "base"}
                border="base"
                borderRadius="base"
                padding="small"
                onClick={() => setPending(language.code)}
              >
                <s-stack gap="small" direction="inline" alignItems="center">
                  <input
                    type="radio"
                    name={groupName}
                    value={language.code}
                    checked={selected}
                    onChange={() => setPending(language.code)}
                    className="st-visually-hidden"
                  />
                  <LanguageFlag language={language} chip />
                  {/*
                    The endonym is always in the language's own script, so a
                    merchant who cannot read English still finds their language.
                    The English name is `aria-hidden` to avoid announcing the pair
                    twice.
                  */}
                  <s-text {...passthrough({ type: selected ? "strong" : "generic", style: WRAP })}>
                    {language.nativeName}
                  </s-text>
                  <s-text
                    {...passthrough({
                      fontSize: "small",
                      color: "subdued",
                      "aria-hidden": "true",
                      style: WRAP,
                    })}
                  >
                    {language.englishName}
                  </s-text>
                </s-stack>
              </s-clickable>
            );
          })}
        </div>

        {detected ? <s-badge tone="info">{labels.detected}</s-badge> : null}

        <s-button
          variant="primary"
          onClick={() => onSelect(pending)}
          accessibilityLabel={labels.confirm}
        >
          {labels.confirm}
        </s-button>
      </s-stack>
    </s-box>
  );
}

function endonym(code: LanguageCode): string {
  return LANGUAGES.find((language) => language.code === code)?.nativeName ?? code;
}

/**
 * Language selector wired to the `/app/language` resource route.
 *
 * The `action` is explicit and must stay that way. A `<fetcher>` without one
 * posts to the nearest route in the tree, so on `/app/settings` it would hit the
 * settings action, which expects the whole survey form: the language change
 * would come back as a validation error and never persist.
 *
 * Uses a fetcher rather than a form submit so switching language never unmounts
 * the page the merchant is standing on. A full navigation here would discard an
 * unsaved survey draft in Settings — the most likely place someone changes their
 * mind about their language.
 *
 * React Router revalidates the loader after a fetcher submit, and the shell
 * loader re-reads the merchant's now-saved preference, so the whole app
 * re-renders in the new language with no extra plumbing. The control is disabled
 * while the request is in flight to stop a double-click writing two conflicting
 * values.
 */
export function LanguageForm({
  language,
  detected = false,
  inline = false,
}: {
  language: LanguageCode;
  detected?: boolean;
  inline?: boolean;
}) {
  const fetcher = useFetcher<{ ok: boolean; language: LanguageCode | null }>();
  const t = createTranslator(language);
  const busy = fetcher.state !== "idle";

  return (
    <LanguageSelector
      value={language}
      detected={detected}
      variant={inline ? "inline" : "dialog"}
      disabled={busy}
      labels={{
        title: t("language.select_title"),
        body: t("language.select_body"),
        confirm: t("language.confirm"),
        detected: t("onboarding.language_detected"),
        change: t("language.change"),
        current: t("language.current"),
      }}
      onSelect={(code) => {
        // Already in this language: nothing to save, and a write here would
        // mark the language as "explicitly chosen" for a merchant who never
        // chose it, which would suppress the onboarding picker permanently.
        if (code === language) return;
        fetcher.submit({ language: code }, { method: "post", action: "/app/language" });
      }}
    />
  );
}

/**
 * Decorative flag.
 *
 * `aria-hidden` because it is purely visual: the endonym beside it carries the
 * meaning, and announcing "flag of Japan" before "Japanese" is noise. `chip`
 * adds a themed border so the flag reads as a deliberate element rather than an
 * unexplained rectangle in a list.
 */
export function LanguageFlag({ language, chip = false }: { language: Language; chip?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`st-lang-flag${chip ? " st-lang-flag--chip" : ""}`}
      style={{ backgroundImage: `url("${FLAGS[language.code]}")` }}
    />
  );
}
