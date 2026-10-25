import { useEffect, useMemo, useRef, useState } from "react";
import {
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

import { Banner } from "~/components/admin-ui";
import { FrameText, QuestionList, errorId, type TFn } from "~/components/survey-editor";
import { SurveyPreview } from "~/components/survey-preview";
import { SurveyIdBox } from "~/components/survey-id-box";
import { UnsavedChangesGuard } from "~/components/unsaved-changes";
import { AdvancedTargeting, Audience, Automation, Languages, ShopifyActions } from "~/components/survey-settings-panels";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { resolveAdminLanguage } from "~/lib/i18n/resolve.server";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { ConflictError, NotFoundError, ValidationError } from "~/lib/errors";
import {
  discardSurveyDraft,
  getSurveyRow,
  isOverActiveLimit,
  liveSurveyUsage,
  publishSurveyDraft,
  rowToEditor,
  setSurveyStatus,
  updateSurvey,
  type EditorSurvey,
  type SurveyInput,
} from "~/lib/surveys.server";
import { getShopDisplay, getShopLocaleInfo } from "~/lib/studio.server";
import { isValidTimeZone } from "@shared/zoned-date";
import { grantedSyncScopes } from "~/lib/scopes.server";
import { presetLabels } from "~/lib/channel-presets.server";
import { getBlockSeen, markBlockAdded } from "~/lib/block-seen.server";
import { BlockMissingBanner, postedPlacements } from "~/components/block-missing";
import { checkoutEditorUrl, placementsMissingBlock } from "~/lib/checkout-editor";
import { effectivePlan } from "~/lib/plans";
import { LANGUAGES } from "~/lib/i18n";
import { LIMITS } from "@shared/survey-rules";
import { planTier } from "@shared/plan-features";
import { getReadiness, readinessBlocksGoLive } from "@shared/templates/readiness";
import { templateById } from "@shared/templates";

/**
 * The survey editor.
 *
 * One page, top to bottom: the questions, where the survey shows, who sees it,
 * and a few optional sections. The preview sits beside it on a wide screen and
 * below it on a phone. One button saves; on a live survey it saves and
 * publishes in one step, so there is no separate draft to remember.
 *
 * The whole survey is edited in local state and posted as one JSON blob, so
 * reordering and adding answers never round-trip.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "surveys.editor_title");

export const handle = { titleKey: "surveys.editor_title" };

export const loader = guarded(async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";
  // Only "not found" reads as not found; a database outage must surface as one.
  const row = await getSurveyRow(shop.id, id);
  // A deleted survey or a stale link goes back to the list, not to the error
  // screen; a database outage still surfaces as one.
  if (!row) return redirect("/app/surveys");
  const survey = rowToEditor(row);

  const [display, localeInfo] = await Promise.all([
    getShopDisplay(shop.id, shop.shopDomain, session.accessToken),
    getShopLocaleInfo(shop.id, shop.shopDomain, session.accessToken),
  ]);
  const usage = await liveSurveyUsage(shop.id);
  const template = survey.templateId ? templateById(survey.templateId) : undefined;

  return {
    survey,
    shopHandle: shop.shopDomain.replace(".myshopify.com", ""),
    shopCurrency: display.currencyCode ?? null,
    // Start and end dates are the store's calendar days, in its own zone.
    shopTimeZone: isValidTimeZone(localeInfo.timeZone) ? localeInfo.timeZone : null,
    languages: LANGUAGES.map((l) => ({ code: l.code, name: l.nativeName })),
    defaultLanguage: resolveAdminLanguage(request, shop.language, shop.adminLocale),
    limits: LIMITS,
    plan: planTier(effectivePlan(shop)),
    grantedScopes: grantedSyncScopes(session.scope),
    templatePresets: template?.smartActions ?? [],
    overActiveLimit: survey.status !== "active" && (await isOverActiveLimit(shop.id, survey.id)),
    liveLimit: usage.limit,
    // Which pages have ever shown the SourceTrac block. "Live" is only claimed
    // for those; anywhere else the merchant is sent to add the block.
    blockSeen: await getBlockSeen(shop.id),
    // "Use answers for a country": the generic answers' wording in the
    // merchant's language and every buyer language, and the store's country.
    presetLabels: presetLabels(resolveAdminLanguage(request, shop.language, shop.adminLocale)),
    shopCountry: localeInfo.countryCode,
  };
});

/**
 * Set on the redirect after a survey is turned on or its changes published.
 * If the block has never been seen on one of the survey's pages, the editor
 * opens Shopify's checkout editor so the merchant can add it.
 */
const OPEN_CHECKOUT = "open_checkout";

const INTENTS = new Set(["save", "go-live", "publish", "discard", "pause", "activate", "block-added"]);

/** A survey-level ValidationError or ConflictError, as the editor renders it. */
function failure(error: unknown) {
  if (error instanceof ValidationError) {
    return { ok: false as const, conflict: false, issues: extractIssues(error) };
  }
  if (error instanceof ConflictError) {
    return { ok: false as const, conflict: true, issues: [] };
  }
  return null;
}

export const action = guarded(async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");
  if (!INTENTS.has(intent)) {
    return { ok: false as const, conflict: false, issues: [{ path: "", code: "unknown_intent", message: "That action is not supported." }] };
  }
  // The concurrency token the editor loaded. Every post carries it; one
  // without it is refused rather than skipping the check.
  const rawRevision = form.get("revision");
  const expectedRevision = typeof rawRevision === "string" && rawRevision !== "" ? Number(rawRevision) : Number.NaN;
  if (!Number.isInteger(expectedRevision)) {
    return { ok: false as const, conflict: true, issues: [] };
  }

  if (intent === "block-added") {
    await markBlockAdded(shop.id, postedPlacements(form));
    return redirect(`/app/surveys/${id}`);
  }

  try {
    if (intent === "publish") {
      await publishSurveyDraft(shop.id, id, expectedRevision);
      return redirect(`/app/surveys/${id}?published=1&${OPEN_CHECKOUT}=1`);
    }
    if (intent === "discard") {
      await discardSurveyDraft(shop.id, id, expectedRevision);
      return redirect(`/app/surveys/${id}?discarded=1`);
    }
    if (intent === "pause") {
      await setSurveyStatus(shop.id, id, "paused");
      return redirect(`/app/surveys/${id}?paused=1`);
    }
    if (intent === "activate") {
      await setSurveyStatus(shop.id, id, "active");
      return redirect(`/app/surveys/${id}?launched=1&${OPEN_CHECKOUT}=1`);
    }
  } catch (error) {
    const result = failure(error);
    if (result) return result;
    if (error instanceof NotFoundError) return redirect("/app/surveys");
    throw error;
  }

  // A missing or unreadable body is answered like any refused save, not with
  // the error screen.
  const unreadable = {
    ok: false as const,
    conflict: false,
    issues: [{ path: "", code: "unreadable", message: "The survey could not be read. Reload the page and save again." }],
  };
  const raw = form.get("survey");
  if (typeof raw !== "string" || raw.length === 0) return unreadable;
  let input: SurveyInput;
  try {
    input = JSON.parse(raw) as SurveyInput;
  } catch {
    return unreadable;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return unreadable;

  // An order-value rule is in the store's currency, read from Shopify here so
  // a client's guess can never set it. Without one the rule matched no order.
  const targeting = input.targeting;
  if (targeting && (targeting.minValue != null || targeting.maxValue != null)) {
    const display = await getShopDisplay(shop.id, shop.shopDomain, session.accessToken);
    if (display.currencyCode) targeting.valueCurrency = display.currencyCode;
    else if (!targeting.valueCurrency) {
      return {
        ok: false as const,
        conflict: false,
        issues: [
          {
            path: "targeting.minValue",
            code: "currency_unavailable",
            message: "Your store's currency could not be read just now. Try saving again in a moment.",
          },
        ],
      };
    }
  }

  try {
    const saved = await updateSurvey(shop.id, id, input, expectedRevision);
    if (intent === "go-live") {
      await setSurveyStatus(shop.id, id, "active");
      return redirect(`/app/surveys/${id}?launched=1&${OPEN_CHECKOUT}=1`);
    }
    // A live or paused survey's save is held as a draft. Publish it straight
    // away: one button, and buyers see the change. The draft step still exists
    // underneath for the concurrency check, it just never waits on a second
    // click.
    if (saved.hasDraft) {
      await publishSurveyDraft(shop.id, id, saved.revision);
      return redirect(`/app/surveys/${id}?published=1&${OPEN_CHECKOUT}=1`);
    }
  } catch (error) {
    const result = failure(error);
    if (result) return result;
    if (error instanceof NotFoundError) return redirect("/app/surveys");
    throw error;
  }
  return redirect(`/app/surveys/${id}?saved=1`);
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

function issueText(t: TFn, issue: EditorIssue, params: Record<string, unknown> = {}): string {
  const key = `surveys.validation_${issue.code}`;
  const translated = t(key, params);
  return translated === key ? issue.message : translated;
}

/** The success notice for a redirect back to the editor, if any. */
const NOTICES = ["launched", "published", "saved", "paused", "discarded"] as const;

export default function SurveyEditorPage() {
  const data = useLoaderData<typeof loader>();
  const { survey, limits, plan } = data;
  const { t, language } = useAdminI18n();
  const navigation = useNavigation();
  const [params, setParams] = useSearchParams();
  const submit = useSubmit();
  const actionData = useActionData<typeof action>();

  const [draft, setDraft] = useState<EditorSurvey>(survey);
  const initial = useRef(JSON.stringify(survey));

  // After a save the loader hands back the stored survey. Reset the editor to
  // it, keyed on the merchant-only revision: `updatedAt` moves on every
  // shopper answer and would throw away unsaved edits.
  //
  // Not after a refused save, though: the loader re-runs with the other
  // window's revision, and resetting then threw the merchant's unsaved edits
  // away (and switched the unsaved-changes guard off). They stay on screen
  // until the merchant chooses to load the latest version.
  // With nothing unsaved, a refused Publish or Discard simply picks up the
  // latest version, so the next click is not refused again.
  const conflicted = actionData?.ok === false && actionData.conflict;
  const keepUnsavedEdits = conflicted && JSON.stringify(draft) !== initial.current;
  const dataKey = `${survey.revision}:${survey.hasDraft}:${survey.status}`;
  const lastKey = useRef(dataKey);
  useEffect(() => {
    if (lastKey.current === dataKey || keepUnsavedEdits) return;
    lastKey.current = dataKey;
    setDraft(survey);
    initial.current = JSON.stringify(survey);
  }, [dataKey, survey, keepUnsavedEdits]);
  const loadLatest = () => {
    lastKey.current = dataKey;
    setDraft(survey);
    initial.current = JSON.stringify(survey);
  };

  const errors = useMemo(() => {
    const map = new Map<string, string>();
    if (actionData && actionData.ok === false) {
      for (const issue of actionData.issues) map.set(issue.path, issueText(t, issue, { limit: data.liveLimit }));
    }
    return map;
  }, [actionData, t, data.liveLimit]);

  const firstErrorPath = actionData && actionData.ok === false ? actionData.issues[0]?.path : undefined;
  useEffect(() => {
    if (!firstErrorPath) return;
    document.getElementById(errorId(firstErrorPath))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [firstErrorPath]);

  const dirty = JSON.stringify(draft) !== initial.current;
  const busy = navigation.state !== "idle";
  const pendingIntent = navigation.formData?.get("intent");
  const update = (patch: Partial<EditorSurvey>) => setDraft((d) => ({ ...d, ...patch }));
  // Back to the last saved version. The saved copy is the JSON `dirty` compares
  // against, so the editor is clean again the moment this runs.
  const discardChanges = () => setDraft(JSON.parse(initial.current) as EditorSurvey);

  const readinessInput = {
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
    maxQuestions: null,
    overActiveLimit: data.overActiveLimit,
    configBytes: new TextEncoder().encode(JSON.stringify(draft)).length,
    blockAdded: null,
    translationsComplete: null,
  };
  const readiness = getReadiness(readinessInput);
  // Going live (or activating) must fit the plan's live-survey limit. Saving
  // the changes of a survey that is not live does not make it live, so a
  // paused survey at the limit can still be fixed and saved.
  const blocked = readinessBlocksGoLive(readiness);
  const saveBlocked =
    draft.status === "active" ? blocked : readinessBlocksGoLive(getReadiness({ ...readinessInput, overActiveLimit: false }));
  const problems = readiness.filter((item) => !item.ok && item.ok !== null);

  const post = (intent: string) => {
    const body = new FormData();
    body.set("intent", intent);
    body.set("revision", String(draft.revision));
    if (intent === "save" || intent === "go-live") body.set("survey", JSON.stringify(draft));
    submit(body, { method: "post" });
  };

  const notice = NOTICES.find((key) => params.get(key) === "1");

  // Pages this survey is on where the SourceTrac block has never loaded. The
  // app cannot see the checkout editor, so "live" is only claimed where a
  // block has asked for a survey; everywhere else the merchant is told to add it.
  const missing = survey.status === "active" ? placementsMissingBlock(survey.placements, data.blockSeen) : [];
  // Buyers see nothing until the Thank-you block is in; the Order status page
  // is an optional extra on top.
  const thankYouMissing = missing.includes("thank_you");
  const editorHref = checkoutEditorUrl(data.shopHandle, missing[0] ?? "thank_you");

  // Straight after turning the survey on or publishing it, go to the checkout
  // editor to add the block. The flag is dropped from the address first, and
  // remembered per revision, so going back to this page never bounces the
  // merchant out again.
  const openCheckout = params.get(OPEN_CHECKOUT) === "1" && missing.length > 0;
  useEffect(() => {
    if (params.get(OPEN_CHECKOUT) !== "1") return;
    const next = new URLSearchParams(params);
    next.delete(OPEN_CHECKOUT);
    setParams(next, { replace: true, preventScrollReset: true });
    if (!openCheckout || alreadyOpened(survey.id, survey.revision)) return;
    rememberOpened(survey.id, survey.revision);
    window.open(editorHref, "_top");
  }, [params, setParams, openCheckout, editorHref, survey.id, survey.revision]);
  const created = params.get("created") === "1";
  const freeVersion = params.get("free_version") === "1";

  const actions = (
    <ActionButtons
      draft={draft}
      t={t}
      dirty={dirty}
      busy={busy}
      pendingIntent={typeof pendingIntent === "string" ? pendingIntent : null}
      blocked={blocked}
      saveBlocked={saveBlocked}
      onPost={post}
      onDiscardChanges={discardChanges}
    />
  );

  return (
    <s-stack gap="base">
      {/* Nothing leaves this page with unsaved edits: Shopify's save bar, a
          held navigation with Save / Discard and leave / Keep editing, and a
          reload prompt. See the component for which covers what. */}
      <UnsavedChangesGuard
        dirty={dirty}
        saving={busy}
        saveLabel={draft.status === "draft" ? t("editor.save_draft") : t("editor.save_publish")}
        // A draft can always be saved; any other save publishes, and the page
        // says what stops it.
        saveDisabled={draft.status !== "draft" && saveBlocked}
        onSave={() => post("save")}
        onDiscard={discardChanges}
        t={t}
      />
      <s-link href="/app/surveys">{t("surveys.back_to_list")}</s-link>
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text fontSize="large-100" fontWeight="bold">
            {draft.name || t("editor.untitled")}
          </s-text>
          <StatusBadge status={draft.status} hasDraft={draft.hasDraft} noBlock={thankYouMissing} t={t} />
        </s-stack>
        <StatusLine draft={draft} missing={missing} t={t} />
      </s-stack>

      {actionData && actionData.ok === false ? (
        actionData.conflict ? (
          <Banner tone="warning" heading={t("studio.conflict")}>
            {dirty ? (
              <s-stack gap="small-200">
                <s-text>{t("studio.conflict_kept")}</s-text>
                <s-button onClick={loadLatest}>{t("studio.conflict_load_latest")}</s-button>
              </s-stack>
            ) : null}
          </Banner>
        ) : (
          <Banner tone="critical" heading={t("editor.save_failed")}>
            <s-stack gap="small-200">
              {actionData.issues.slice(0, 3).map((issue, i) => (
                <s-text key={i}>{issueText(t, issue, { limit: data.liveLimit })}</s-text>
              ))}
            </s-stack>
          </Banner>
        )
      ) : created && !dirty ? (
        <Banner tone="success" heading={t("editor.created_title")}>
          <s-text>{freeVersion ? t("editor.created_free_version", { plan: t("plans.growth") }) : t("editor.created_body")}</s-text>
        </Banner>
      ) : missing.length > 0 && !dirty ? (
        <BlockMissingBanner
          missing={missing}
          shopHandle={data.shopHandle}
          heading={notice === "launched" || notice === "published" ? t(`editor.notice_${notice}_no_block`) : undefined}
          t={t}
        />
      ) : notice && !dirty ? (
        <Banner tone="success" heading={t(`editor.notice_${notice}`)} />
      ) : null}

      {actions}

      <s-query-container>
        <s-grid gridTemplateColumns="@container (inline-size > 880px) minmax(0, 1fr) minmax(0, 340px), minmax(0, 1fr)" gap="base">
          <s-stack gap="base">
            <s-section heading={t("editor.questions_title")}>
              <s-stack gap="base">
                <s-text color="subdued">{t("editor.questions_help")}</s-text>
                <QuestionList
                  draft={draft}
                  update={update}
                  t={t}
                  limits={limits}
                  errors={errors}
                  plan={plan}
                  presets={{ labels: data.presetLabels, shopCountry: data.shopCountry, language }}
                />
              </s-stack>
            </s-section>

            <s-section heading={t("editor.where_title")}>
              <s-stack gap="small">
                {/* The Thank-you page is always on, so a survey can never sit on
                    no page. The Order status page is an optional extra. */}
                <s-checkbox
                  label={t("editor.placement_thank_you")}
                  details={t("editor.placement_thank_you_details")}
                  checked
                  disabled
                />
                <s-checkbox
                  label={t("editor.placement_order_status")}
                  details={t("editor.placement_order_status_details")}
                  checked={draft.placements.includes("order_status") || undefined}
                  onChange={(e: Event) => {
                    const checked = (e.currentTarget as { checked?: boolean }).checked === true;
                    update({ placements: checked ? ["thank_you", "order_status"] : ["thank_you"] });
                  }}
                />
                <s-text color="subdued" fontSize="small">
                  {t("editor.placement_once")}
                </s-text>
              </s-stack>
            </s-section>

            <s-section heading={t("editor.who_title")}>
              <s-stack gap="base">
                <Audience draft={draft} update={update} t={t} />
                <details className="st-details">
                  <summary>{t("editor.more_rules")}</summary>
                  <AdvancedTargeting
                    draft={draft}
                    update={update}
                    shopCurrency={data.shopCurrency}
                    shopTimeZone={data.shopTimeZone}
                    language={language}
                    errors={errors}
                    t={t}
                    plan={plan}
                  />
                </details>
              </s-stack>
            </s-section>

            <s-section heading={t("editor.optional_title")}>
              <s-stack gap="small">
                <details className="st-details">
                  <summary>{t("editor.look_title")}</summary>
                  <FrameText draft={draft} update={update} t={t} limits={limits} />
                </details>
                <details className="st-details">
                  <summary>{t("editor.languages_title")}</summary>
                  <Languages
                    draft={draft}
                    update={update}
                    languages={data.languages}
                    defaultLanguage={data.defaultLanguage}
                    t={t}
                    limits={limits}
                  />
                </details>
                <details className="st-details">
                  <summary>{t("editor.actions_title")}</summary>
                  <ShopifyActions
                    draft={draft}
                    update={update}
                    t={t}
                    grantedScopes={data.grantedScopes}
                    plan={plan}
                    templatePresets={data.templatePresets}
                  />
                </details>
                <details className="st-details">
                  <summary>{t("editor.automation_title")}</summary>
                  <Automation draft={draft} update={update} t={t} plan={plan} />
                </details>
                <s-text-field
                  label={t("editor.name")}
                  details={t("editor.name_details")}
                  value={draft.name}
                  maxLength={limits.MAX_SURVEY_NAME}
                  onInput={(e: Event) => update({ name: (e.currentTarget as { value?: string }).value ?? "" })}
                />
              </s-stack>
            </s-section>
          </s-stack>

          <s-stack gap="base">
            <s-section heading={t("preview.title")}>
              <SurveyPreview survey={draft} t={t} />
            </s-section>

            {problems.length > 0 ? (
              <s-section heading={t("editor.fix_title")}>
                <s-stack gap="small">
                  {problems.map((item) => (
                    <s-stack key={item.id} direction="inline" gap="small" alignItems="center">
                      <s-icon type="alert-circle" tone={item.blocking ? "critical" : "caution"} />
                      <s-text>{t(`editor.ready_${item.id}`, { limit: data.liveLimit })}</s-text>
                    </s-stack>
                  ))}
                </s-stack>
              </s-section>
            ) : null}

            <s-section heading={t("editor.store_title")}>
              <s-stack gap="small">
                <s-ordered-list>
                  <s-list-item>{t("editor.store_step_block")}</s-list-item>
                  {draft.placements.includes("order_status") ? (
                    <s-list-item>{t("editor.store_step_order_status")}</s-list-item>
                  ) : null}
                  <s-list-item>{t("editor.store_step_live")}</s-list-item>
                  <s-list-item>{t("editor.store_step_test")}</s-list-item>
                </s-ordered-list>
                <s-button href={editorHref} target="_top" icon="external">
                  {t("editor.open_checkout_editor")}
                </s-button>
                <SurveyIdBox surveyId={survey.id} t={t} />
                <s-text color="subdued" fontSize="small">
                  {t("editor.survey_id_not_showing")}
                </s-text>
              </s-stack>
            </s-section>

            {survey.responseCount > 0 ? (
              <s-button href={`/app/results?survey=${survey.id}`} icon="chart-vertical">
                {t("editor.see_answers", { count: survey.responseCount })}
              </s-button>
            ) : null}
          </s-stack>
        </s-grid>
      </s-query-container>

      {actions}
    </s-stack>
  );
}

function StatusLine({ draft, missing, t }: { draft: EditorSurvey; missing: readonly string[]; t: TFn }) {
  const shown = draft.placements.filter((p) => !missing.includes(p));
  const places = shown.map((p) => t(`editor.placement_${p}`)).join(", ");
  const text =
    draft.status === "active"
      ? draft.hasDraft
        ? t("editor.status_live_draft")
        : shown.length === 0
          ? t("editor.status_on_no_block")
          : t("editor.status_live", { places })
      : draft.status === "paused"
        ? draft.pausedAutomatically
          ? t("editor.status_auto_paused")
          : t("editor.status_paused")
        : t("editor.status_draft");
  return <s-text color="subdued">{text}</s-text>;
}

function ActionButtons({
  draft,
  t,
  dirty,
  busy,
  pendingIntent,
  blocked,
  saveBlocked,
  onPost,
  onDiscardChanges,
}: {
  draft: EditorSurvey;
  t: TFn;
  dirty: boolean;
  busy: boolean;
  pendingIntent: string | null;
  /** Going live or activating is blocked. */
  blocked: boolean;
  /** Saving and publishing changes is blocked. */
  saveBlocked: boolean;
  onPost: (intent: string) => void;
  onDiscardChanges: () => void;
}) {
  const loading = (intent: string) => (busy && pendingIntent === intent) || undefined;
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {draft.status === "draft" ? (
        <>
          <s-button variant="primary" disabled={blocked || busy || undefined} loading={loading("go-live")} onClick={() => onPost("go-live")}>
            {t("editor.go_live")}
          </s-button>
          <s-button disabled={!dirty || busy || undefined} loading={loading("save")} onClick={() => onPost("save")}>
            {t("editor.save_draft")}
          </s-button>
        </>
      ) : (
        <s-button variant="primary" disabled={!dirty || saveBlocked || busy || undefined} loading={loading("save")} onClick={() => onPost("save")}>
          {t("editor.save_publish")}
        </s-button>
      )}
      {draft.status === "active" ? (
        <s-button disabled={dirty || busy || undefined} loading={loading("pause")} onClick={() => onPost("pause")}>
          {t("surveys.pause")}
        </s-button>
      ) : null}
      {draft.status === "paused" ? (
        <s-button disabled={dirty || blocked || busy || undefined} loading={loading("activate")} onClick={() => onPost("activate")}>
          {t("surveys.activate")}
        </s-button>
      ) : null}
      {draft.hasDraft && !dirty ? (
        <>
          <s-button disabled={saveBlocked || busy || undefined} onClick={() => onPost("publish")}>
            {t("studio.publish")}
          </s-button>
          <s-button tone="critical" variant="tertiary" disabled={busy || undefined} onClick={() => onPost("discard")}>
            {t("studio.discard")}
          </s-button>
        </>
      ) : null}
      {dirty ? (
        <>
          <s-button variant="tertiary" disabled={busy || undefined} onClick={onDiscardChanges}>
            {t("editor.discard_changes")}
          </s-button>
          <s-text color="subdued" fontSize="small">
            {t("editor.unsaved")}
          </s-text>
        </>
      ) : null}
    </s-stack>
  );
}

function StatusBadge({
  status,
  hasDraft,
  noBlock,
  t,
}: {
  status: EditorSurvey["status"];
  hasDraft: boolean;
  noBlock: boolean;
  t: TFn;
}) {
  if (status === "active" && noBlock) return <s-badge tone="warning">{t("studio.status_no_block")}</s-badge>;
  if (status === "active" && hasDraft) return <s-badge tone="warning">{t("studio.status_live_draft")}</s-badge>;
  if (status === "active") return <s-badge tone="success">{t("surveys.status_active")}</s-badge>;
  if (status === "paused") return <s-badge tone="warning">{t("surveys.status_paused")}</s-badge>;
  return <s-badge tone="neutral">{t("surveys.status_draft")}</s-badge>;
}

const OPENED_KEY = "sourcetrac:checkout-editor-opened";

function alreadyOpened(surveyId: string, revision: number): boolean {
  try {
    return window.sessionStorage.getItem(OPENED_KEY) === `${surveyId}:${revision}`;
  } catch {
    return false;
  }
}

function rememberOpened(surveyId: string, revision: number): void {
  try {
    window.sessionStorage.setItem(OPENED_KEY, `${surveyId}:${revision}`);
  } catch {
    // No storage: the flag is already gone from the address, which covers a
    // reload; only going back through history could open the editor again.
  }
}
