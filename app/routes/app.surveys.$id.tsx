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
import { getShopDisplay } from "~/lib/studio.server";
import { grantedSyncScopes, hasScope } from "~/lib/scopes.server";
import { SMART_ACTION_PRESETS } from "@shared/templates/smart-actions";
import { effectivePlan } from "~/lib/plans";
import { LANGUAGES } from "~/lib/i18n";
import { LIMITS } from "@shared/survey-rules";
import { planTier } from "@shared/plan-features";
import { getReadiness, readinessBlocksGoLive } from "@shared/templates/readiness";
import { templateById } from "@shared/templates";
import type { Placement } from "@shared/survey-config";

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
  if (!row) throw new NotFoundError("That survey does not exist.", { surveyId: id });
  const survey = rowToEditor(row);

  const display = await getShopDisplay(shop.id, shop.shopDomain, session.accessToken);
  const usage = await liveSurveyUsage(shop.id);
  const template = survey.templateId ? templateById(survey.templateId) : undefined;

  return {
    survey,
    shopHandle: shop.shopDomain.replace(".myshopify.com", ""),
    shopCurrency: display.currencyCode ?? "USD",
    languages: LANGUAGES.map((l) => ({ code: l.code, name: l.nativeName })),
    defaultLanguage: resolveAdminLanguage(request, shop.language, shop.adminLocale),
    limits: LIMITS,
    plan: planTier(effectivePlan(shop)),
    grantedScopes: grantedSyncScopes(session.scope),
    // Customer presets need write_customers, which the app no longer requests.
    // Offer them only where the scope exists or the survey already uses one,
    // so a merchant is never shown a switch that can do nothing.
    templatePresets: (template?.smartActions ?? []).filter(
      (id) =>
        SMART_ACTION_PRESETS[id]?.scope !== "write_customers" ||
        hasScope(session.scope, "write_customers") ||
        presetIdsOf(survey.syncOptions).includes(id),
    ),
    overActiveLimit: survey.status !== "active" && (await isOverActiveLimit(shop.id, survey.id)),
    liveLimit: usage.limit,
  };
});

function presetIdsOf(syncOptions: Record<string, unknown>): string[] {
  const presets = syncOptions.presets;
  return Array.isArray(presets) ? presets.filter((id): id is string => typeof id === "string") : [];
}

const INTENTS = new Set(["save", "go-live", "publish", "discard", "pause", "activate"]);

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

  try {
    if (intent === "publish") {
      await publishSurveyDraft(shop.id, id, expectedRevision);
      return redirect(`/app/surveys/${id}?published=1`);
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
      return redirect(`/app/surveys/${id}?launched=1`);
    }
  } catch (error) {
    const result = failure(error);
    if (result) return result;
    if (error instanceof NotFoundError) return redirect("/app/surveys");
    throw error;
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
    const saved = await updateSurvey(shop.id, id, input, expectedRevision);
    if (intent === "go-live") {
      await setSurveyStatus(shop.id, id, "active");
      return redirect(`/app/surveys/${id}?launched=1`);
    }
    // A live or paused survey's save is held as a draft. Publish it straight
    // away: one button, and buyers see the change. The draft step still exists
    // underneath for the concurrency check, it just never waits on a second
    // click.
    if (saved.hasDraft) {
      await publishSurveyDraft(shop.id, id, saved.revision);
      return redirect(`/app/surveys/${id}?published=1`);
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
  const { t } = useAdminI18n();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const submit = useSubmit();
  const actionData = useActionData<typeof action>();

  const [draft, setDraft] = useState<EditorSurvey>(survey);
  const initial = useRef(JSON.stringify(survey));

  // After a save the loader hands back the stored survey. Reset the editor to
  // it, keyed on the merchant-only revision: `updatedAt` moves on every
  // shopper answer and would throw away unsaved edits.
  const dataKey = `${survey.revision}:${survey.hasDraft}:${survey.status}`;
  const lastKey = useRef(dataKey);
  useEffect(() => {
    if (lastKey.current === dataKey) return;
    lastKey.current = dataKey;
    setDraft(survey);
    initial.current = JSON.stringify(survey);
  }, [dataKey, survey]);

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
    overActiveLimit: data.overActiveLimit,
    configBytes: new TextEncoder().encode(JSON.stringify(draft)).length,
    blockAdded: null,
    translationsComplete: null,
  });
  const blocked = readinessBlocksGoLive(readiness);
  const problems = readiness.filter((item) => !item.ok && item.ok !== null);

  const post = (intent: string) => {
    const body = new FormData();
    body.set("intent", intent);
    body.set("revision", String(draft.revision));
    if (intent === "save" || intent === "go-live") body.set("survey", JSON.stringify(draft));
    submit(body, { method: "post" });
  };

  const notice = NOTICES.find((key) => params.get(key) === "1");
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
      onPost={post}
    />
  );

  return (
    <s-stack gap="base">
      <s-link href="/app/surveys">{t("surveys.back_to_list")}</s-link>
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text fontSize="large-100" fontWeight="bold">
            {draft.name || t("editor.untitled")}
          </s-text>
          <StatusBadge status={draft.status} hasDraft={draft.hasDraft} t={t} />
        </s-stack>
        <StatusLine draft={draft} t={t} />
      </s-stack>

      {actionData && actionData.ok === false ? (
        actionData.conflict ? (
          <Banner tone="warning" heading={t("studio.conflict")} />
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
                <QuestionList draft={draft} update={update} t={t} limits={limits} errors={errors} plan={plan} />
              </s-stack>
            </s-section>

            <s-section heading={t("editor.where_title")}>
              <s-stack gap="small">
                {(["thank_you", "order_status"] as const).map((p) => (
                  <s-checkbox
                    key={p}
                    label={t(`editor.placement_${p}`)}
                    details={t(`editor.placement_${p}_details`)}
                    checked={draft.placements.includes(p) || undefined}
                    error={p === "thank_you" ? errors.get("placements") : undefined}
                    onChange={(e: Event) => {
                      const checked = (e.currentTarget as { checked?: boolean }).checked === true;
                      const next: Placement[] = checked
                        ? [...new Set([...draft.placements, p])]
                        : draft.placements.filter((x) => x !== p);
                      update({ placements: next });
                    }}
                  />
                ))}
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
                  <AdvancedTargeting draft={draft} update={update} shopCurrency={data.shopCurrency} t={t} plan={plan} />
                </details>
              </s-stack>
            </s-section>

            <s-section heading={t("editor.optional_title")}>
              <s-stack gap="small">
                <details className="st-details">
                  <summary>{t("editor.wording_title")}</summary>
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
                  <s-list-item>{t("editor.store_step_live")}</s-list-item>
                  <s-list-item>{t("editor.store_step_test")}</s-list-item>
                </s-ordered-list>
                <s-button
                  href={`https://admin.shopify.com/store/${data.shopHandle}/settings/checkout/editor?page=thank-you`}
                  target="_top"
                  icon="external"
                >
                  {t("editor.open_checkout_editor")}
                </s-button>
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

function StatusLine({ draft, t }: { draft: EditorSurvey; t: TFn }) {
  const places = draft.placements.map((p) => t(`editor.placement_${p}`)).join(", ");
  const text =
    draft.status === "active"
      ? draft.hasDraft
        ? t("editor.status_live_draft")
        : t("editor.status_live", { places: places || t("editor.placement_none") })
      : draft.status === "paused"
        ? t("editor.status_paused")
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
  onPost,
}: {
  draft: EditorSurvey;
  t: TFn;
  dirty: boolean;
  busy: boolean;
  pendingIntent: string | null;
  blocked: boolean;
  onPost: (intent: string) => void;
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
        <s-button variant="primary" disabled={!dirty || blocked || busy || undefined} loading={loading("save")} onClick={() => onPost("save")}>
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
          <s-button disabled={blocked || busy || undefined} onClick={() => onPost("publish")}>
            {t("studio.publish")}
          </s-button>
          <s-button tone="critical" variant="tertiary" disabled={busy || undefined} onClick={() => onPost("discard")}>
            {t("studio.discard")}
          </s-button>
        </>
      ) : null}
      {dirty ? (
        <s-text color="subdued" fontSize="small">
          {t("editor.unsaved")}
        </s-text>
      ) : null}
    </s-stack>
  );
}

function StatusBadge({ status, hasDraft, t }: { status: EditorSurvey["status"]; hasDraft: boolean; t: TFn }) {
  if (status === "active" && hasDraft) return <s-badge tone="warning">{t("studio.status_live_draft")}</s-badge>;
  if (status === "active") return <s-badge tone="success">{t("surveys.status_active")}</s-badge>;
  if (status === "paused") return <s-badge tone="warning">{t("surveys.status_paused")}</s-badge>;
  return <s-badge tone="neutral">{t("surveys.status_draft")}</s-badge>;
}
