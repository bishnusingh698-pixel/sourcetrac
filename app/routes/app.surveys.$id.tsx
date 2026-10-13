import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { SurveyEditor, errorId, type TFn } from "~/components/survey-editor";
import { SurveyPreview } from "~/components/survey-preview";
import { CheckoutMock, type PreviewPlacement } from "~/components/checkout-mock";
import { SyncSettings, Targeting, Translations } from "~/components/survey-settings-panels";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { intlLocaleFor } from "~/lib/i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { NotFoundError, ValidationError } from "~/lib/errors";
import {
  discardSurveyDraft,
  getEditorSurvey,
  publishSurveyDraft,
  setSurveyStatus,
  updateSurvey,
  type EditorSurvey,
  type SurveyInput,
} from "~/lib/surveys.server";
import { getShopDisplay } from "~/lib/studio.server";
import { grantedSyncScopes } from "~/lib/scopes.server";
import { formatMoney } from "~/lib/money";
import { DEFAULT_SURVEY_TEXT } from "@shared/survey-config";
import { LANGUAGES } from "~/lib/i18n";
import { isEnabled } from "@shared/feature-flags";
import { LIMITS } from "@shared/survey-rules";
import { getReadiness, readinessBlocksGoLive } from "@shared/templates/readiness";
import type { Placement } from "@shared/survey-config";

/**
 * Survey Studio (S1).
 *
 * A three-panel workspace: edit on the left, a realistic checkout preview in the
 * middle, and "Where & who" plus the ready check on the right. On medium screens
 * the right panel becomes a fourth segment; on phones it is a top-level tab.
 *
 * The whole survey is edited in local state and posted as one JSON blob, so
 * reordering and adding options never round-trip. For a live survey, saving
 * writes a DRAFT (S7) that shoppers never see until "Publish changes".
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "surveys.editor_title");

export const loader = guarded(async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";
  const survey = await getEditorSurvey(shop.id, id).catch(() => null);
  if (!survey) throw new NotFoundError("That survey does not exist.", { surveyId: id });

  const display = await getShopDisplay(shop.id, shop.shopDomain, session.accessToken);
  const language = resolveAdminLanguage(request, shop.language, shop.adminLocale);
  const locale = intlLocaleFor(language);
  const currency = display.currencyCode ?? "USD";
  // A believable order total, formatted in the shop's own currency. Never a real
  // order: the mock always shows "#1001" and "Alex".
  const sampleTotal = formatMoney(4250, currency, locale);

  return {
    survey,
    shopName: display.name ?? shop.shopDomain.replace(".myshopify.com", ""),
    shopCurrency: currency,
    sampleTotal,
    product: display.product,
    languages: LANGUAGES.map((l) => ({ code: l.code, name: l.nativeName })),
    limits: LIMITS,
    defaults: DEFAULT_SURVEY_TEXT,
    grantedScopes: grantedSyncScopes(session.scope),
    onsiteEnabled: isEnabled("ONSITE_SURVEYS"),
    surveyLinkEnabled: isEnabled("SURVEY_LINK_PAGE"),
  };
});

export const action = guarded(async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  if (intent === "publish") {
    try {
      await publishSurveyDraft(shop.id, id);
    } catch (error) {
      if (error instanceof ValidationError) {
        return { ok: false as const, issues: extractIssues(error) };
      }
      throw error;
    }
    return redirect(`/app/surveys/${id}?tab=studio&published=1`);
  }

  if (intent === "discard") {
    await discardSurveyDraft(shop.id, id);
    return redirect(`/app/surveys/${id}?tab=studio&discarded=1`);
  }

  if (intent === "pause") {
    await setSurveyStatus(shop.id, id, "paused");
    return redirect(`/app/surveys/${id}?tab=studio`);
  }

  if (intent === "activate") {
    await setSurveyStatus(shop.id, id, "active");
    return redirect(`/app/surveys/${id}?tab=studio`);
  }

  const raw = form.get("survey");
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError("The survey was not submitted.", "Reload the page and save again.");
  }

  let input: SurveyInput;
  try {
    input = JSON.parse(raw) as SurveyInput;
  } catch {
    throw new ValidationError("The survey could not be read.", "Reload the page and save again.");
  }

  try {
    await updateSurvey(shop.id, id, input);
    // "Go live" saves the survey, then activates it in one round trip. A
    // live/paused survey's save lands as a draft, so activation is only
    // meaningful for a draft, which `updateSurvey` writes directly.
    if (intent === "go-live") {
      await setSurveyStatus(shop.id, id, "active");
      return redirect(`/app/surveys/${id}?tab=studio&launched=1`);
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false as const, issues: extractIssues(error) };
    }
    throw error;
  }
  return redirect(`/app/surveys/${id}?tab=studio&saved=1`);
});

/** Validation issues carried on a ValidationError, with a translated message. */
export type EditorIssue = { path: string; code: string; message: string };

function extractIssues(error: ValidationError): EditorIssue[] {
  const raw = error.fields.issues;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .filter((i): i is EditorIssue => typeof i === "object" && i !== null && typeof (i as EditorIssue).path === "string")
      .map((i) => ({ path: i.path, code: i.code, message: i.message }));
  }
  const field = typeof error.fields.field === "string" ? error.fields.field : "";
  return [{ path: field, code: typeof error.fields.code === "string" ? error.fields.code : "invalid", message: error.message }];
}

function issueText(t: TFn, issue: EditorIssue): string {
  const key = `surveys.validation_${issue.code}`;
  const translated = t(key);
  return translated === key ? issue.message : translated;
}

type StudioTab = "overview" | "studio" | "results" | "settings";
type EditView = "questions" | "design" | "logic";

/** Old tab names that should keep working as bookmarks. */
const LEGACY_TABS: Record<string, StudioTab> = {
  questions: "studio",
  logic: "studio",
  who: "studio",
  targeting: "studio",
  sync: "settings",
  translations: "settings",
};

function resolveTab(raw: string | null, survey: EditorSurvey): StudioTab {
  if (raw && LEGACY_TABS[raw]) return LEGACY_TABS[raw];
  if (raw === "overview" || raw === "studio" || raw === "results" || raw === "settings") return raw;
  // Landing tab: a draft with no responses opens the Studio; otherwise Overview.
  return survey.status === "draft" && survey.responseCount === 0 ? "studio" : "overview";
}

export default function SurveyStudio() {
  const data = useLoaderData<typeof loader>();
  const { survey, limits, grantedScopes } = data;
  const { t } = useAdminI18n();
  const navigation = useNavigation();
  const [params, setParams] = useSearchParams();
  const submit = useSubmit();

  const [draft, setDraft] = useState<EditorSurvey>(survey);
  const initial = useRef(JSON.stringify(survey));
  const actionData = useActionData<typeof action>();

  // After a save/publish/pause the loader re-runs and hands back the persisted
  // survey. Reset the local editor to it, or the form would still show the
  // pre-save values and read as dirty.
  const dataKey = `${survey.updatedAt}:${survey.hasDraft}:${survey.status}`;
  const lastKey = useRef(dataKey);
  useEffect(() => {
    if (lastKey.current === dataKey) return;
    lastKey.current = dataKey;
    setDraft(survey);
    initial.current = JSON.stringify(survey);
  }, [dataKey, survey]);

  const tab = resolveTab(params.get("tab"), survey);
  const [view, setView] = useState<EditView>("questions");
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<PreviewPlacement>("thank_you");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewLocale, setPreviewLocale] = useState<string>("");
  const [showRules, setShowRules] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const errors = useMemo(() => {
    const map = new Map<string, string>();
    if (actionData && actionData.ok === false) {
      for (const issue of actionData.issues) map.set(issue.path, issueText(t, issue));
    }
    return map;
  }, [actionData, t]);

  const firstErrorPath = actionData && actionData.ok === false ? actionData.issues[0]?.path : undefined;
  useEffect(() => {
    if (!firstErrorPath) return;
    document.getElementById(errorId(firstErrorPath))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [firstErrorPath]);

  const dirty = JSON.stringify(draft) !== initial.current;
  const saving = navigation.state === "submitting";

  // App Bridge contextual save bar. Never mixed with `data-save-bar`.
  useEffect(() => {
    const bridge = (globalThis as { shopify?: { saveBar?: SaveBarApi } }).shopify;
    if (!bridge?.saveBar) return;
    if (dirty) bridge.saveBar.show("survey-editor");
    else bridge.saveBar.hide("survey-editor");
  }, [dirty]);

  const update = (patch: Partial<EditorSurvey>) => setDraft((d) => ({ ...d, ...patch }));

  const readiness = getReadiness({
    definition: {
      id: draft.id,
      name: draft.name,
      title: draft.title,
      intro: draft.intro,
      buttonLabel: draft.buttonLabel,
      thankYouText: draft.thankYouText,
      layout: draft.layout,
      questions: draft.questions,
    },
    placements: draft.placements,
    maxQuestions: null,
    overActiveLimit: false,
    configBytes: new TextEncoder().encode(JSON.stringify(draft)).length,
    blockAdded: null,
    translationsComplete: null,
  });
  const blocked = readinessBlocksGoLive(readiness);

  const setTab = (next: StudioTab) => {
    const search = new URLSearchParams(params);
    search.set("tab", next);
    setParams(search, { preventScrollReset: true });
  };

  // Status actions (go live / publish / pause / activate / discard) are not form
  // saves, so they post a small intent payload instead of the whole survey.
  const submitIntent = (intent: string) => {
    const body = new FormData();
    body.set("intent", intent);
    submit(body, { method: "post" });
  };

  const selectQuestion = (questionId: string) => {
    setActiveQuestionId(questionId);
    setView("questions");
    requestAnimationFrame(() => {
      document.getElementById(`q-${questionId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const previewPlacement = placement as Placement;
  const placementUsed = draft.placements.includes(previewPlacement);

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
        <s-link href="/app/surveys">{t("surveys.back_to_list")}</s-link>
        <StatusBadge status={draft.status} hasDraft={draft.hasDraft} t={t} />
      </s-stack>

      <s-section heading={draft.name} subheading={t("studio.right_purpose")} padding="none" />

      {actionData && actionData.ok === false ? (
        <Banner tone="critical" heading={t("surveys.save_failed_title")}>
          {t("surveys.save_failed_body", { count: actionData.issues.length })}
        </Banner>
      ) : null}

      <s-stack direction="inline" gap="small">
        {(["overview", "studio", "results", "settings"] as StudioTab[]).map((name) => (
          <s-button key={name} variant={tab === name ? "primary" : "secondary"} onClick={() => setTab(name)}>
            {t(`studio.tab_${name}`)}
          </s-button>
        ))}
      </s-stack>

      {tab === "overview" ? <OverviewTab draft={draft} t={t} /> : null}

      {tab === "results" ? <ResultsHint t={t} /> : null}

      {tab === "settings" ? (
        <SettingsTab
          draft={draft}
          update={update}
          t={t}
          grantedScopes={grantedScopes}
          limits={limits}
          languages={data.languages}
          shopCurrency={data.shopCurrency}
        />
      ) : null}

      {tab === "studio" ? (
        <Form method="post">
          <input type="hidden" name="survey" value={JSON.stringify(draft)} />

          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size > 1200px) minmax(0, 340px) minmax(0, 1fr) minmax(0, 300px), @container (inline-size > 768px) minmax(0, 1fr) minmax(0, 1fr), 1fr"
              gap="base"
            >
              <s-stack gap="base">
                <s-section heading={t("studio.name_label")} subheading={t("studio.left_purpose")} padding="none" />
                <s-text-field
                  label={t("studio.name_label")}
                  value={draft.name}
                  maxLength={limits.MAX_SURVEY_NAME}
                  onInput={(e: Event) => update({ name: (e.currentTarget as { value?: string }).value ?? "" })}
                />
                <SurveyEditor
                  draft={draft}
                  update={update}
                  t={t}
                  errors={errors}
                  view={view}
                  setView={setView}
                  activeQuestionId={activeQuestionId}
                />
              </s-stack>

              <s-stack gap="base">
                <s-section heading={t("surveys.preview_title")} subheading={t("studio.center_purpose")} padding="none" />
                <s-stack direction="inline" gap="small">
                  {placementTabs(data).map((p) => (
                    <s-button
                      key={p.value}
                      variant={placement === p.value ? "primary" : "secondary"}
                      onClick={() => setPlacement(p.value)}
                    >
                      {t(p.labelKey)}
                    </s-button>
                  ))}
                  <s-button
                    variant={device === "desktop" ? "primary" : "secondary"}
                    accessibilityLabel={t("studio.device_desktop")}
                    onClick={() => setDevice("desktop")}
                  >
                    {t("studio.device_desktop")}
                  </s-button>
                  <s-button
                    variant={device === "mobile" ? "primary" : "secondary"}
                    accessibilityLabel={t("studio.device_mobile")}
                    onClick={() => setDevice("mobile")}
                  >
                    {t("studio.device_mobile")}
                  </s-button>
                </s-stack>

                {!placementUsed ? <Banner tone="info" heading={t("studio.where_title")}>{t("studio.placement_not_used")}</Banner> : null}

                <CheckoutMock
                  placement={placement}
                  device={device}
                  shopName={data.shopName}
                  total={data.sampleTotal}
                  product={data.product}
                  labels={{
                    orderSummary: t("studio.order_summary"),
                    orderNumber: "#1001",
                    thankYou: t("studio.thank_you_sample"),
                    confirmed: t("studio.confirmed_sample"),
                    orderStatus: t("studio.placement_order_status"),
                    fulfillment: t("studio.fulfillment_sample"),
                    surveyLink: t("studio.placement_link"),
                    onSite: t("studio.placement_onsite"),
                  }}
                >
                  <SurveyPreview
                    survey={draft}
                    languages={data.languages}
                    t={t}
                    showChrome={false}
                    showNote={false}
                    previewLocale={previewLocale}
                    onSelectQuestion={selectQuestion}
                    highlightQuestionId={activeQuestionId}
                  />
                </CheckoutMock>

                <s-text color="subdued" fontSize="small">
                  {t("studio.preview_caption")}
                </s-text>

                <s-select
                  label={t("studio.preview_language")}
                  value={previewLocale}
                  onChange={(e: Event) => setPreviewLocale((e.currentTarget as { value?: string }).value ?? "")}
                >
                  <s-option value="">{t("studio.preview_default_language")}</s-option>
                  {data.languages.map((l) => (
                    <s-option key={l.code} value={l.code}>
                      {l.name}
                    </s-option>
                  ))}
                </s-select>
              </s-stack>

              <s-stack gap="base">
                <GoLivePanel
                  draft={draft}
                  update={update}
                  t={t}
                  readiness={readiness}
                  blocked={blocked}
                  dirty={dirty}
                  onEditRules={() => setShowRules(true)}
                  onGoLive={() => submitIntent("go-live")}
                  onPause={() => submitIntent("pause")}
                  onActivate={() => submitIntent("activate")}
                  onPublish={() => submitIntent("publish")}
                />
              </s-stack>
            </s-grid>
          </s-query-container>

          <s-box paddingBlockStart="base">
            <s-stack direction="inline" gap="small">
              <s-button variant="primary" type="submit" loading={saving || undefined}>
                {saving ? t("common.saving") : t("surveys.save")}
              </s-button>
              {draft.hasDraft ? (
                <>
                  <s-button
                    type="button"
                    disabled={blocked || dirty || undefined}
                    onClick={() => submitIntent("publish")}
                  >
                    {t("studio.publish")}
                  </s-button>
                  <s-button type="button" tone="critical" onClick={() => setConfirmDiscard(true)}>
                    {t("studio.discard")}
                  </s-button>
                </>
              ) : null}
            </s-stack>
          </s-box>
        </Form>
      ) : null}

      {showRules ? (
        <WhoSeesModal
          draft={draft}
          update={update}
          t={t}
          limits={limits}
          shopCurrency={data.shopCurrency}
          onClose={() => setShowRules(false)}
        />
      ) : null}

      {confirmDiscard ? (
        <s-modal heading={t("studio.discard_title")} onHide={() => setConfirmDiscard(false)}>
          <s-stack gap="base">
            <s-button type="button" tone="critical" onClick={() => { setConfirmDiscard(false); submitIntent("discard"); }}>
              {t("studio.discard")}
            </s-button>
            <s-button type="button" onClick={() => setConfirmDiscard(false)}>
              {t("studio.cancel")}
            </s-button>
          </s-stack>
        </s-modal>
      ) : null}
    </s-stack>
  );
}

function placementTabs(data: { onsiteEnabled: boolean; surveyLinkEnabled: boolean }) {
  const tabs: Array<{ value: PreviewPlacement; labelKey: string }> = [
    { value: "thank_you", labelKey: "studio.placement_thank_you" },
    { value: "order_status", labelKey: "studio.placement_order_status" },
  ];
  if (data.surveyLinkEnabled) tabs.push({ value: "link", labelKey: "studio.placement_link" });
  if (data.onsiteEnabled) tabs.push({ value: "onsite", labelKey: "studio.placement_onsite" });
  return tabs;
}

function StatusBadge({ status, hasDraft, t }: { status: EditorSurvey["status"]; hasDraft: boolean; t: TFn }) {
  if (status === "active" && hasDraft) return <s-badge tone="warning">{t("studio.status_live_draft")}</s-badge>;
  if (status === "active") return <s-badge tone="success">{t("surveys.status_active")}</s-badge>;
  if (status === "paused") return <s-badge tone="warning">{t("surveys.status_paused")}</s-badge>;
  return <s-badge tone="neutral">{t("surveys.status_draft")}</s-badge>;
}

function audienceLabel(draft: EditorSurvey, t: TFn): string {
  const type = draft.targeting.customerType ?? "everyone";
  return t(`surveys.customer_${type === "first_order" ? "first" : type === "returning" ? "returning" : "everyone"}`);
}

function OverviewTab({ draft, t }: { draft: EditorSurvey; t: TFn }) {
  const statusLine =
    draft.status === "active"
      ? draft.hasDraft
        ? t("studio.status_live_draft")
        : t("studio.status_live", { places: draft.placements.map((p) => t(`studio.placement_${p}`)).join(", ") })
      : draft.status === "paused"
        ? t("studio.status_paused")
        : t("studio.status_draft");

  return (
    <s-stack gap="base">
      <Panel title={t("surveys.status_active")} description={statusLine}>
        <s-stack direction="inline" gap="base">
          <s-stack gap="small-200">
            <s-text type="strong" fontSize="small">
              {t("surveys.col_responses")}
            </s-text>
            <s-heading>{String(draft.responseCount)}</s-heading>
          </s-stack>
          <s-stack gap="small-200">
            <s-text type="strong" fontSize="small">
              {t("studio.who_title")}
            </s-text>
            <s-text>{audienceLabel(draft, t)}</s-text>
          </s-stack>
        </s-stack>
      </Panel>
      <Panel title={t("studio.ready_title")} description={t("studio.right_purpose")}>
        <s-link href={`/app/surveys/${draft.id}?tab=studio`}>{t("studio.tab_golive")}</s-link>
      </Panel>
    </s-stack>
  );
}

function ResultsHint({ t }: { t: TFn }) {
  return (
    <Panel title={t("results.title")} description={t("results.subtitle")}>
      <s-link href="/app/results">{t("results.title")}</s-link>
    </Panel>
  );
}

function SettingsTab({
  draft,
  update,
  t,
  grantedScopes,
  limits,
  languages,
  shopCurrency,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  grantedScopes: string[];
  limits: typeof LIMITS;
  languages: Array<{ code: string; name: string }>;
  shopCurrency: string;
}) {
  return (
    <s-stack gap="base">
      <Panel title={t("surveys.section_sync")}>
        <SyncSettings draft={draft} update={update} t={t} grantedScopes={grantedScopes} />
      </Panel>
      <Panel title={t("surveys.section_translations")}>
        <Translations draft={draft} update={update} languages={languages} t={t} />
      </Panel>
      <Panel title={t("surveys.section_targeting")}>
        <Targeting draft={draft} update={update} shopCurrency={shopCurrency} t={t} limits={limits} />
      </Panel>
      {draft.templateId ? (
        <Panel title={t("surveys.templates_title")}>
          <s-text color="subdued">
            {t("studio.template_info", { count: draft.questions.length })} · v{draft.templateVersion ?? 1}
          </s-text>
        </Panel>
      ) : null}
    </s-stack>
  );
}

function GoLivePanel({
  draft,
  update,
  t,
  readiness,
  blocked,
  dirty,
  onEditRules,
  onGoLive,
  onPause,
  onActivate,
  onPublish,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  readiness: ReturnType<typeof getReadiness>;
  blocked: boolean;
  dirty: boolean;
  onEditRules: () => void;
  onGoLive: () => void;
  onPause: () => void;
  onActivate: () => void;
  onPublish: () => void;
}) {
  return (
    <s-stack gap="base">
      <s-section heading={t("studio.tab_golive")} subheading={t("studio.right_purpose")} padding="none" />

      <s-stack gap="small">
        <s-text type="strong">{t("studio.where_title")}</s-text>
        {(["thank_you", "order_status"] as const).map((p) => (
          <s-checkbox
            key={p}
            name={`placement-${p}`}
            label={t(`studio.placement_${p}`)}
            checked={draft.placements.includes(p) || undefined}
            onChange={(e: Event) => {
              const checked = (e.currentTarget as { checked?: boolean }).checked === true;
              const next = checked ? [...new Set([...draft.placements, p])] : draft.placements.filter((x) => x !== p);
              update({ placements: next });
            }}
          />
        ))}
        <s-text color="subdued" fontSize="small">
          {t("surveys.placement_help")}
        </s-text>
      </s-stack>

      <s-stack gap="small">
        <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
          <s-text type="strong">{t("studio.who_title")}</s-text>
          <s-badge tone="neutral">{audienceLabel(draft, t)}</s-badge>
        </s-stack>
        <s-button type="button" onClick={onEditRules}>
          {t("studio.edit_rules")}
        </s-button>
      </s-stack>

      <s-stack gap="small">
        <s-text type="strong">{t("studio.ready_title")}</s-text>
        {readiness.map((item) => (
          <s-stack key={item.id} direction="inline" gap="small" alignItems="center">
            <s-badge tone={item.ok ? "success" : item.blocking ? "critical" : "warning"}>{item.ok ? "✓" : "!"}</s-badge>
            <s-text>{t(`ready.${item.id}`)}</s-text>
          </s-stack>
        ))}
        {!blocked ? (
          <s-text color="subdued" fontSize="small">
            {t("studio.ready_pass")}
          </s-text>
        ) : null}
      </s-stack>

      <s-stack gap="small">
        {draft.status === "draft" ? (
          <s-button type="button" variant="primary" disabled={blocked || undefined} onClick={onGoLive}>
            {t("studio.go_live")}
          </s-button>
        ) : null}
        {draft.status === "active" && !draft.hasDraft ? (
          <s-button type="button" onClick={onPause}>
            {t("surveys.pause")}
          </s-button>
        ) : null}
        {draft.status === "active" && draft.hasDraft ? (
          <s-button type="button" disabled={blocked || dirty || undefined} onClick={onPublish}>
            {t("studio.publish")}
          </s-button>
        ) : null}
        {draft.status === "paused" ? (
          <s-button type="button" onClick={onActivate}>
            {t("surveys.activate")}
          </s-button>
        ) : null}
      </s-stack>
    </s-stack>
  );
}

function WhoSeesModal({
  draft,
  update,
  t,
  limits,
  shopCurrency,
  onClose,
}: {
  draft: EditorSurvey;
  update: (patch: Partial<EditorSurvey>) => void;
  t: TFn;
  limits: typeof LIMITS;
  shopCurrency: string;
  onClose: () => void;
}) {
  return (
    <s-modal heading={t("studio.rules_title")} onHide={onClose}>
      <s-stack gap="base">
        <Targeting draft={draft} update={update} shopCurrency={shopCurrency} t={t} limits={limits} hideAdvanced />
        <s-switch
          label={t("setup.learn_stop")}
          details={t("setup.learn_stop_help")}
          checked={draft.learnAndStop || undefined}
          onChange={(e: Event) => update({ learnAndStop: (e.currentTarget as { checked?: boolean }).checked === true })}
        />
        <s-switch
          label={t("setup.rotation")}
          details={t("setup.rotation_help")}
          checked={draft.rotation || undefined}
          onChange={(e: Event) => update({ rotation: (e.currentTarget as { checked?: boolean }).checked === true })}
        />
        <s-stack direction="inline" gap="small">
          <s-button type="button" variant="primary" onClick={onClose}>
            {t("studio.apply")}
          </s-button>
          <s-button type="button" onClick={onClose}>
            {t("studio.cancel")}
          </s-button>
        </s-stack>
      </s-stack>
    </s-modal>
  );
}

type SaveBarApi = {
  show: (id: string) => void;
  hide: (id: string) => void;
};
