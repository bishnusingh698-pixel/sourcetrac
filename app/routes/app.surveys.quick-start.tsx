import { useMemo, useState } from "react";
import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";

import { SectionTabs } from "~/components/section-tabs";
import { Banner, PageIntro, Panel } from "~/components/admin-ui";
import { CountrySelect, countryName } from "~/components/country-select";
import { SurveyPreview } from "~/components/survey-preview";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { ValidationError } from "~/lib/errors";
import { createSurvey, liveSurveyUsage, type EditorSurvey } from "~/lib/surveys.server";
import { getShopLocaleInfo } from "~/lib/studio.server";
import { presetLabels } from "~/lib/channel-presets.server";
import { presetAnswersForCountry } from "~/lib/preset-options";
import { quickStartSurveyInput, type QuickStartChoice } from "~/lib/quick-start";
import { isCountryCode } from "@shared/countries";
import { DEFAULT_DESIGN, LIMITS } from "@shared/survey-rules";
import { TEMPLATE_LOCALES, templateText } from "@shared/templates/locales";

/**
 * Quick start (F1): a live "How did you hear about us?" survey in about two
 * minutes, on one screen.
 *
 * 1. Where most buyers are: the answers of that market load (LINE and Yahoo!
 *    JAPAN for Japan, Snapchat for the Gulf, WhatsApp for Brazil...).
 * 2. Untick what does not apply, add the merchant's own.
 * 3. Go live. The editor then opens Shopify's checkout editor to add the block,
 *    exactly as its own Go live does.
 *
 * The live preview beside it is the editor's own, so what the merchant sees is
 * what the editor will show. When the plan's live-survey limit is used, the
 * survey is created as a draft and the page says so before the click.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "quick.title");

export const handle = { titleKey: "nav.surveys" };

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const language = resolveAdminLanguage(request, shop.language, shop.adminLocale);
  const lang = TEMPLATE_LOCALES.includes(language) ? language : "en";
  const [{ countryCode }, usage] = await Promise.all([
    getShopLocaleInfo(shop.id, shop.shopDomain, session.accessToken),
    liveSurveyUsage(shop.id),
  ]);
  const text = (key: string) => templateText(lang, key);
  return {
    shopCountry: countryCode && isCountryCode(countryCode) ? countryCode : "US",
    labels: presetLabels(lang),
    // The words the survey will use, for the preview.
    words: {
      question: text("templates.channel-compass.q_channel.text"),
      followUp: text("templates.channel-compass.q_creator.text"),
      followUpPlaceholder: text("templates.channel-compass.q_creator.placeholder"),
      title: text("frame.title"),
      intro: text("frame.intro"),
      button: text("frame.button"),
      thanks: text("frame.thankyou"),
    },
    liveLimit: usage.limit,
    limitReached: usage.limit !== null && usage.live >= usage.limit,
  };
});

/** Read and check the posted choice; never trust a label for a preset answer. */
function readChoice(raw: unknown): QuickStartChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const strings = (list: unknown, max: number) =>
    Array.isArray(list) ? list.filter((v): v is string => typeof v === "string" && v.length <= 80).slice(0, max) : [];
  if (typeof value.country !== "string" || !isCountryCode(value.country)) return null;
  return {
    country: value.country,
    keys: strings(value.keys, LIMITS.MAX_OPTIONS),
    custom: strings(value.custom, LIMITS.MAX_OPTIONS),
    allowOther: value.allowOther === true,
    followUp: value.followUp === true,
  };
}

export const action = guarded(async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const form = await request.formData();
  let choice: QuickStartChoice | null = null;
  try {
    choice = readChoice(JSON.parse(String(form.get("choice") ?? "")));
  } catch {
    choice = null;
  }
  if (!choice) return { ok: false as const, code: "unreadable" };

  const language = resolveAdminLanguage(request, shop.language, shop.adminLocale);
  const usage = await liveSurveyUsage(shop.id);
  const status = usage.limit !== null && usage.live >= usage.limit ? "draft" : "active";
  try {
    const survey = await createSurvey(shop.id, quickStartSurveyInput(choice, language, status));
    return redirect(
      status === "active" ? `/app/surveys/${survey.id}?launched=1&open_checkout=1` : `/app/surveys/${survey.id}?created=1`,
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false as const, code: typeof error.fields.code === "string" ? error.fields.code : "invalid" };
    }
    throw error;
  }
});

export default function QuickStart() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { t, language } = useAdminI18n();
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const [country, setCountry] = useState(data.shopCountry);
  const { answers } = useMemo(() => presetAnswersForCountry(country, data.labels, null), [country, data.labels]);
  // Unticked preset answers, per country, so switching back keeps the choice.
  const [unticked, setUnticked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<string[]>([]);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [allowOther, setAllowOther] = useState(true);
  const [followUp, setFollowUp] = useState(false);

  const off = new Set(unticked[country] ?? []);
  const keys = answers.filter((a) => !off.has(a.key)).map((a) => a.key);
  const total = keys.length + custom.length;
  const tooFew = total < LIMITS.MIN_OPTIONS;
  const full = total >= LIMITS.MAX_OPTIONS;

  const toggle = (key: string, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(key);
    else next.add(key);
    setUnticked({ ...unticked, [country]: [...next] });
  };
  const addCustom = () => {
    const label = draftAnswer.trim().slice(0, LIMITS.MAX_OPTION_LABEL);
    if (!label || full) return;
    const taken = [...answers.map((a) => a.label), ...custom].some((l) => l.toLowerCase() === label.toLowerCase());
    if (!taken) setCustom([...custom, label]);
    setDraftAnswer("");
  };

  // The survey as the editor would show it, for the live preview.
  const preview: EditorSurvey = useMemo(() => {
    const chosen = [
      ...answers.filter((a) => keys.includes(a.key)).map((a) => ({ id: `p_${a.key}`, label: a.label, key: a.key })),
      ...custom.map((label, i) => ({ id: `c_${i}`, label, key: null as string | null })),
    ].slice(0, LIMITS.MAX_OPTIONS);
    const triggers = chosen.filter((o) =>
      o.key ? ["creator_influencer", "instagram", "youtube", "tiktok", "podcast", "x_twitter", "snapchat", "douyin", "xiaohongshu"].includes(o.key) : false,
    );
    const option = (o: { id: string; label: string }) => ({
      id: o.id,
      label: o.label,
      isOther: false,
      exclusive: false,
      archived: false,
      translations: {},
    });
    return {
      id: "quick-start",
      name: data.words.question,
      status: "draft",
      priority: 0,
      placements: ["thank_you"],
      layout: "all",
      title: data.words.title,
      intro: data.words.intro,
      buttonLabel: data.words.button,
      thankYouText: data.words.thanks,
      channelReportQuestionId: "q1",
      targeting: {},
      syncOptions: {},
      translations: {},
      version: 1,
      responseCount: 0,
      templateId: null,
      templateVersion: null,
      rotation: false,
      rotationWeight: 2,
      learnAndStop: false,
      autoPausedAt: null,
      pausedAutomatically: false,
      design: DEFAULT_DESIGN,
      draftUpdatedAt: null,
      hasDraft: false,
      revision: 0,
      updatedAt: "",
      questions: [
        {
          id: "q1",
          type: "single_choice",
          text: data.words.question,
          required: true,
          allowOther,
          randomizeOptions: false,
          translations: {},
          options: chosen.map(option),
        },
        ...(followUp && triggers.length > 0
          ? [
              {
                id: "q2",
                type: "text" as const,
                text: data.words.followUp,
                placeholder: data.words.followUpPlaceholder,
                required: false,
                translations: {},
                showIf: { questionId: "q1", optionIds: triggers.map((o) => o.id) },
                options: [],
              },
            ]
          : []),
      ],
    };
  }, [answers, keys, custom, allowOther, followUp, data.words]);

  const launch = () => {
    const body = new FormData();
    body.set("choice", JSON.stringify({ country, keys, custom, allowOther, followUp }));
    submit(body, { method: "post" });
  };

  const failure = actionData && actionData.ok === false ? actionData.code : null;
  const failureText = failure ? (t(`surveys.validation_${failure}`) === `surveys.validation_${failure}` ? t("quick.failed") : t(`surveys.validation_${failure}`, { limit: data.liveLimit ?? "" })) : null;

  return (
    <s-stack gap="base">
      <SectionTabs section="surveys" t={t} />
      <PageIntro
        actions={
          <s-button href="/app/surveys/library" variant="tertiary">
            {t("quick.templates_link")}
          </s-button>
        }
      >
        {t("quick.subtitle")}
      </PageIntro>
      {failureText ? <Banner tone="critical" heading={failureText} /> : null}

      <s-query-container>
        <s-grid gridTemplateColumns="@container (inline-size > 880px) minmax(0, 1fr) minmax(0, 340px), minmax(0, 1fr)" gap="base">
          <s-stack gap="base">
            <Panel title={t("quick.country_title")} description={t("quick.country_help")}>
              <CountrySelect
                value={country}
                onChange={setCountry}
                language={language}
                label={t("presets.country_label")}
                searchLabel={t("presets.search")}
                noMatch={t("presets.no_match")}
              />
            </Panel>

            <Panel
              title={t("quick.answers_title")}
              description={t("quick.answers_help", { country: countryName(country, language) })}
            >
              <s-stack gap="small">
                {answers.map((answer) => (
                  <s-checkbox
                    key={answer.key}
                    label={answer.label}
                    checked={!off.has(answer.key) || undefined}
                    disabled={(off.has(answer.key) && full) || undefined}
                    onChange={(e: Event) => toggle(answer.key, (e.currentTarget as { checked?: boolean }).checked === true)}
                  />
                ))}
                {custom.map((label) => (
                  <s-stack key={label} direction="inline" gap="small" alignItems="center">
                    <s-checkbox label={label} checked disabled />
                    <s-button
                      type="button"
                      variant="tertiary"
                      icon="x"
                      accessibilityLabel={t("quick.custom_remove", { label })}
                      onClick={() => setCustom(custom.filter((c) => c !== label))}
                    />
                  </s-stack>
                ))}
                <s-grid gridTemplateColumns="minmax(0, 1fr) auto" gap="small" alignItems="end">
                  <s-text-field
                    label={t("quick.add_label")}
                    value={draftAnswer}
                    maxLength={LIMITS.MAX_OPTION_LABEL}
                    disabled={full || undefined}
                    onInput={(e: Event) => setDraftAnswer((e.currentTarget as { value?: string }).value ?? "")}
                  />
                  <s-button type="button" onClick={addCustom} disabled={full || !draftAnswer.trim() || undefined}>
                    {t("quick.add_button")}
                  </s-button>
                </s-grid>
                <s-text color="subdued" fontSize="small">
                  {t("editor.answer_count", { count: total, max: LIMITS.MAX_OPTIONS })}
                </s-text>
                <s-switch
                  label={t("quick.other")}
                  details={t("quick.other_details")}
                  checked={allowOther || undefined}
                  onChange={(e: Event) => setAllowOther((e.currentTarget as { checked?: boolean }).checked === true)}
                />
                <s-switch
                  label={t("quick.follow_up")}
                  details={t("quick.follow_up_details")}
                  checked={followUp || undefined}
                  onChange={(e: Event) => setFollowUp((e.currentTarget as { checked?: boolean }).checked === true)}
                />
              </s-stack>
            </Panel>

            <Panel title={t("quick.launch_title")} description={t("quick.launch_help")}>
              <s-stack gap="small">
                {data.limitReached ? (
                  <s-text color="subdued">{t("quick.limit_note", { count: data.liveLimit ?? 1 })}</s-text>
                ) : null}
                {tooFew ? <s-text tone="critical">{t("quick.too_few", { min: LIMITS.MIN_OPTIONS })}</s-text> : null}
                <div>
                  <s-button variant="primary" onClick={launch} disabled={tooFew || busy || undefined} loading={busy || undefined}>
                    {data.limitReached ? t("quick.create_draft") : t("quick.go_live")}
                  </s-button>
                </div>
              </s-stack>
            </Panel>
          </s-stack>

          <s-section heading={t("preview.title")}>
            <SurveyPreview survey={preview} t={t} />
          </s-section>
        </s-grid>
      </s-query-container>
    </s-stack>
  );
}
