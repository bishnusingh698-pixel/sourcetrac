import { Form, redirect, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { useState } from "react";

import { Panel, type BadgeTone } from "~/components/admin-ui";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import {
  createSurvey,
  deleteSurvey,
  duplicateSurvey,
  listSurveys,
  reorderSurveys,
  setSurveyStatus,
  type SurveyListItem,
} from "~/lib/surveys.server";
import { findTemplate } from "@shared/survey-templates";
import { NotFoundError, ValidationError } from "~/lib/errors";

/**
 * Surveys list.
 *
 * One primary action per state: "Use a template" when the list is empty,
 * "Create survey" otherwise. Row actions cover Edit, Duplicate, Pause/Activate
 * and Delete. Priority is edited with up/down controls rather than drag, which
 * is keyboard-accessible for free.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "surveys.title");

function statusTone(status: SurveyListItem["status"]): BadgeTone {
  if (status === "active") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

export const loader = guarded(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const surveys = await listSurveys(shop.id);

  return {
    surveys,
  };
});

export const action = guarded(async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const surveyId = String(form.get("surveyId") ?? "");

  // Expected refusals (a limit, a missing placement, a survey deleted in another
  // tab) are shown on the page, not turned into the generic 500 screen.
  try {
    return await runListAction(shop.id, intent, surveyId, form);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      const code = typeof error.fields.code === "string" ? error.fields.code : error.code;
      return { ok: false as const, code, message: error.message };
    }
    throw error;
  }
});

async function runListAction(shopId: string, intent: string, surveyId: string, form: FormData) {
  const shop = { id: shopId };
  switch (intent) {
    case "create-from-template": {
      const template = findTemplate(String(form.get("templateId") ?? ""));
      if (!template) throw new ValidationError("That template does not exist.", "Pick another template.");
      const survey = await createSurvey(shop.id, {
        name: template.survey.name ?? "Untitled survey",
        status: "draft",
        placements: ["thank_you", "order_status"],
        layout: template.survey.layout ?? "all",
        title: template.survey.title ?? "Quick question",
        intro: template.survey.intro ?? null,
        buttonLabel: template.survey.buttonLabel ?? "Submit",
        thankYouText: template.survey.thankYouText ?? "Thanks for your feedback!",
        questions: template.survey.questions.map((question) => ({
          ...question,
          options: question.options?.map((option) => ({ ...option })),
        })),
      });
      return redirect(`/app/surveys/${survey.id}`);
    }

    case "create-blank": {
      const survey = await createSurvey(shop.id, {
        name: "Untitled survey",
        status: "draft",
        placements: ["thank_you"],
        layout: "all",
        title: "Quick question",
        intro: "Your answer helps us improve. It takes 10 seconds.",
        buttonLabel: "Submit",
        thankYouText: "Thanks for your feedback!",
        questions: [
          {
            type: "single_choice",
            text: "How did you hear about us?",
            required: true,
            allowOther: true,
            options: [
              { label: "Instagram" },
              { label: "Google search" },
              { label: "Friend or family" },
              { label: "Online ad" },
            ],
          },
        ],
      });
      return redirect(`/app/surveys/${survey.id}`);
    }

    case "duplicate": {
      const survey = await duplicateSurvey(shop.id, surveyId);
      return redirect(`/app/surveys/${survey.id}`);
    }

    case "pause":
      await setSurveyStatus(shop.id, surveyId, "paused");
      return { ok: true as const };

    case "activate":
      await setSurveyStatus(shop.id, surveyId, "active");
      return { ok: true as const };

    case "delete":
      await deleteSurvey(shop.id, surveyId);
      return { ok: true as const };

    case "reorder": {
      const ids = String(form.get("orderedIds") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length > 0) await reorderSurveys(shop.id, ids);
      return { ok: true as const };
    }

    default:
      throw new ValidationError("Unknown action.", "Reload the page and try again.");
  }
}

function StatusBadge({ status }: { status: SurveyListItem["status"] }) {
  const { t } = useAdminI18n();
  return <s-badge tone={statusTone(status)}>{t(`surveys.status_${status}`)}</s-badge>;
}

export default function Surveys() {
  const { surveys } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { t } = useAdminI18n();
  const failureKey = actionData && actionData.ok === false ? `surveys.validation_${actionData.code}` : null;
  const failureText = failureKey ? (t(failureKey) === failureKey ? actionData!.ok === false && actionData!.message : t(failureKey)) : null;

  return (
    <s-stack gap="base">
      <s-section heading={t("surveys.title")} subheading={t("surveys.subtitle")} padding="none" />
      {failureText ? <s-banner tone="critical">{failureText}</s-banner> : null}

      {surveys.length === 0 ? (
        <Panel title={t("surveys.empty_title")} description={t("surveys.empty_body")}>
          <s-stack gap="base">
            <s-stack direction="inline" gap="small">
              <s-link href="/app/surveys/library">
                <s-button variant="primary">{t("surveys.use_template")}</s-button>
              </s-link>
              <Form method="post">
                <input type="hidden" name="intent" value="create-blank" />
                <s-button type="submit">{t("surveys.start_scratch")}</s-button>
              </Form>
            </s-stack>
          </s-stack>
        </Panel>
      ) : (
        <s-stack gap="base">
          <s-stack direction="inline" gap="small">
            <s-link href="/app/surveys/library">
              <s-button variant="primary">{t("surveys.use_template")}</s-button>
            </s-link>
            <Form method="post">
              <input type="hidden" name="intent" value="create-blank" />
              <s-button type="submit">{t("surveys.start_scratch")}</s-button>
            </Form>
          </s-stack>

          <s-banner tone="info">{t("surveys.priority_help")}</s-banner>

          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">{t("surveys.col_name")}</s-table-header>
              <s-table-header>{t("surveys.col_status")}</s-table-header>
              <s-table-header>{t("surveys.col_placement")}</s-table-header>
              <s-table-header>{t("surveys.col_responses")}</s-table-header>
              <s-table-header>{t("surveys.col_updated")}</s-table-header>
              <s-table-header>{t("surveys.col_actions")}</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {surveys.map((survey, index) => (
                <s-table-row key={survey.id}>
                  <s-table-cell>
                    <s-link href={`/app/surveys/${survey.id}`}>{survey.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={survey.status} />
                  </s-table-cell>
                  <s-table-cell>
                    {survey.placements.length > 0
                      ? survey.placements.map((p) => t(`surveys.placement_${p}`)).join(", ")
                      : t("surveys.placement_none")}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text fontVariantNumeric="tabular-nums">{survey.responseCount}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued" fontSize="small">
                      {survey.updatedAt.slice(0, 10)}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <Form method="post">
                        <input type="hidden" name="intent" value="reorder" />
                        <input
                          type="hidden"
                          name="orderedIds"
                          value={move(surveys, index, index - 1).map((s) => s.id).join(",")}
                        />
                        <s-button
                          type="submit"
                          disabled={index === 0 || undefined}
                          accessibilityLabel={t("surveys.move_up")}
                        >
                          ↑
                        </s-button>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="intent" value="reorder" />
                        <input
                          type="hidden"
                          name="orderedIds"
                          value={move(surveys, index, index + 1).map((s) => s.id).join(",")}
                        />
                        <s-button
                          type="submit"
                          disabled={index === surveys.length - 1 || undefined}
                          accessibilityLabel={t("surveys.move_down")}
                        >
                          ↓
                        </s-button>
                      </Form>
                      <s-link href={`/app/surveys/${survey.id}`}>{t("common.edit")}</s-link>
                      <Form method="post">
                        <input type="hidden" name="intent" value="duplicate" />
                        <input type="hidden" name="surveyId" value={survey.id} />
                        <s-button type="submit">{t("surveys.duplicate")}</s-button>
                      </Form>
                      {survey.status === "active" ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="pause" />
                          <input type="hidden" name="surveyId" value={survey.id} />
                          <s-button type="submit">{t("surveys.pause")}</s-button>
                        </Form>
                      ) : (
                        <Form method="post">
                          <input type="hidden" name="intent" value="activate" />
                          <input type="hidden" name="surveyId" value={survey.id} />
                          <s-button type="submit">{t("surveys.activate")}</s-button>
                        </Form>
                      )}
                      <Form method="post">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="surveyId" value={survey.id} />
                        <ConfirmDelete t={t} name={survey.name} />
                      </Form>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      )}
    </s-stack>
  );
}

/** Return a copy of `list` with the item at `from` moved to `to`. */
function move(list: SurveyListItem[], from: number, to: number): SurveyListItem[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item) next.splice(to, 0, item);
  return next;
}

/**
 * Two-step delete. The first tap reveals the consequence and a confirm button;
 * nothing posts until the merchant confirms, and "Cancel" is the default action.
 */
function ConfirmDelete({ t, name }: { t: ReturnType<typeof useAdminI18n>["t"]; name: string }) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <s-button type="button" tone="critical" onClick={() => setAsking(true)}>
        {t("surveys.delete")}
      </s-button>
    );
  }

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-text color="subdued" fontSize="small">
        {t("surveys.delete_confirm", { name })}
      </s-text>
      <s-button type="button" onClick={() => setAsking(false)}>
        {t("common.cancel")}
      </s-button>
      <s-button type="submit" tone="critical">
        {t("surveys.delete")}
      </s-button>
    </s-stack>
  );
}
