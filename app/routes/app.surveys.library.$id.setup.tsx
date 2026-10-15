import { useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";

import { Banner, Panel } from "~/components/admin-ui";
import { SurveyPreview } from "~/components/survey-preview";
import { adminTitle, useAdminI18n } from "~/lib/i18n/use-admin-i18n";
import { ensureShop } from "~/lib/provision.server";
import { guarded } from "~/lib/admin-errors.server";
import { authenticate } from "~/shopify.server";
import { NotFoundError, ValidationError } from "~/lib/errors";
import { createSurvey, type SurveyInput } from "~/lib/surveys.server";
import { definitionToPreview } from "~/lib/preview-model";
import { grantedSyncScopes } from "~/lib/scopes.server";
import { logger } from "~/lib/logger";
import { LANGUAGES } from "~/lib/i18n";
import { isEnabled } from "@shared/feature-flags";
import { LIMITS, validateSurveyDefinition } from "@shared/survey-rules";
import { buildSurveyDefinition } from "@shared/templates/resolve";
import { regionPackFor } from "@shared/templates/packs";
import { templateById } from "@shared/templates";
import { SMART_ACTION_PRESETS } from "@shared/templates/smart-actions";
import { templatePlacements, catalogPlanFromKey, templateLockedForPlan, type CatalogPlan } from "@shared/templates/catalog";
import { getReadiness, readinessBlocksGoLive } from "@shared/templates/readiness";
import { buildWizardSyncOptions, buildWizardTargeting, type WizardConfig } from "@shared/templates/setup";
import { effectivePlan } from "~/lib/plans";
import { fetchShopLocaleInfo } from "~/lib/shopify-graphql.server";
import type { Placement, Targeting } from "@shared/survey-config";
import type { PackFamily, TemplateDefinition } from "@shared/templates/types";

/**
 * Quick setup (T3).
 *
 * A three-step wizard: Customize → Who sees it → Review and go live. It is a
 * wizard, not a form, so there is no contextual save bar and nothing persists
 * until the last step ("Go live" creates and activates the survey, "Save as
 * draft" creates it as a draft).
 *
 * The wizard is a client-side draft over a template. The preview comes from the
 * same `buildSurveyDefinition` + `SurveyPreview` the library and Studio use, so
 * what the merchant sees here is exactly what shoppers get.
 */

export const meta: MetaFunction = ({ matches }) => adminTitle(matches, "setup.title");


const PROFILE_FAMILIES: Array<{ id: PackFamily; labelKey: string }> = [
  { id: "profiles_beauty", labelKey: "packs.profile_beauty_question" },
  { id: "profiles_fashion", labelKey: "packs.profile_fashion_question" },
  { id: "profiles_food", labelKey: "packs.profile_food_question" },
  { id: "profiles_pets", labelKey: "packs.profile_pets_question" },
  { id: "profiles_home", labelKey: "packs.profile_home_question" },
];

function fieldValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function checkboxChecked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked;
}

export const loader = guarded(async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";

  const template = templateById(id);
  if (!template) throw new NotFoundError("That template does not exist.", { templateId: id });

  const { countryCode } = await fetchShopLocaleInfo(shop.shopDomain, session.accessToken);
  const locale = shop.language ?? "en";

  const packQuestion = template.questions.find((q) => q.pack);
  const packFamily = packQuestion?.pack ?? null;
  const isProfile = Boolean(packFamily && packFamily.startsWith("profiles_"));
  const plan = catalogPlanFromKey(effectivePlan(shop));
  // Force the Lite subset on a plan that cannot use the full template, so a
  // direct visit to this URL cannot build a Growth-only survey on Free.
  const lite = new URL(request.url).searchParams.get("lite") === "1" || templateLockedForPlan(template, plan);

  return {
    templateId: template.id,
    templateName: template.nameKey,
    templateVersion: template.version,
    plan,
    region: regionPackFor(countryCode),
    locale,
    lite,
    languages: LANGUAGES.map((l) => ({ code: l.code, name: l.nativeName })),
    surveyLinkEnabled: isEnabled("SURVEY_LINK_PAGE"),
    packFamily,
    isProfile,
    profileFamilies: PROFILE_FAMILIES,
    questions: template.questions.map((q) => ({
      key: q.key,
      required: q.required,
      optionalInSetup: q.optionalInSetup ?? false,
      showIfParentKey: q.showIf?.questionKey ?? null,
      showIfOptionKeys: q.showIf?.optionKeys ?? [],
      hasPack: Boolean(q.pack),
    })),
    defaults: template.defaults,
    hasSmartActions: (template.smartActions ?? []).length > 0,
    smartActionIds: template.smartActions ?? [],
    grantedScopes: grantedSyncScopes(session.scope),
  };
});



export const action = guarded(async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session);
  const id = params.id ?? "";

  const template = templateById(id);
  if (!template) throw new ValidationError("That template does not exist.", "Pick another template.");

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "create") {
    throw new ValidationError("Unknown action.", "Reload the page and try again.");
  }

  let config: WizardConfig;
  try {
    const parsed = JSON.parse(String(form.get("config") ?? "{}")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    config = parsed as WizardConfig;
  } catch {
    return { ok: false as const, code: "invalid", message: "The setup could not be read. Reload the page and try again." };
  }
  const goLive = String(form.get("goLive") ?? "0") === "1";
  const { countryCode } = await fetchShopLocaleInfo(shop.shopDomain, session.accessToken);
  const locale = shop.language ?? "en";

  const plan = catalogPlanFromKey(effectivePlan(shop));
  const definition = buildSurveyDefinition({
    template,
    locale,
    region: regionPackFor(countryCode),
    // Never let a crafted payload build the full Growth template on a plan
    // that cannot use it; the create gate would reject it anyway.
    lite: config.lite === true || templateLockedForPlan(template, plan),
    toggles: config.toggles,
    overrides: config.overrides,
    profileFamily: config.profileFamily,
    design: template.defaults.design,
  });

  const issues = validateSurveyDefinition(definition);
  if (issues.length > 0) {
    return { ok: false as const, code: issues[0]!.code, message: issues[0]!.message };
  }

  const input: SurveyInput = {
    name: config.name?.trim() || definition.name || template.nameKey,
    // Created live in one transaction when launching: a separate activate step
    // could fail after the create, and the retry then made a second survey.
    status: goLive ? "active" : "draft",
    placements: config.placements && config.placements.length > 0 ? config.placements : templatePlacements(template),
    layout: definition.layout ?? "all",
    title: definition.title ?? "Quick question",
    intro: definition.intro ?? null,
    buttonLabel: definition.buttonLabel ?? "Submit",
    thankYouText: definition.thankYouText ?? "Thanks for your feedback!",
    templateId: template.id,
    templateVersion: template.version,
    rotation: config.rotation ?? false,
    rotationWeight: 2,
    learnAndStop: config.learnAndStop ?? template.defaults.learnAndStop ?? false,
    design: definition.design ?? undefined,
    targeting: buildWizardTargeting(config),
    syncOptions: buildWizardSyncOptions(template, config),
    questions: definition.questions.map((q) => ({ ...q, options: q.options?.map((o) => ({ ...o })) })),
  };

  if (goLive && input.placements.length === 0) {
    return { ok: false as const, code: "no_placements", message: "Choose where the survey shows before going live." };
  }

  let created: Awaited<ReturnType<typeof createSurvey>>;
  try {
    created = await createSurvey(shop.id, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      const code = typeof error.fields.code === "string" ? error.fields.code : error.code;
      return { ok: false as const, code, message: error.message };
    }
    throw error;
  }

  if (goLive) {
    logger.info("survey_launched_from_template", { shop_id: shop.id, survey_id: created.id, template: template.id });
    return redirect(`/app/surveys/${created.id}?launched=1`);
  }

  return redirect(`/app/surveys/${created.id}`);
});



export default function QuickSetup() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { t } = useAdminI18n();
  const [params, setParams] = useSearchParams();
  const failureKey = actionData && actionData.ok === false ? `surveys.validation_${actionData.code}` : null;
  const failureText =
    actionData && actionData.ok === false && failureKey
      ? t(failureKey) === failureKey
        ? actionData.message
        : t(failureKey)
      : null;

  const step = Math.min(3, Math.max(1, Number(params.get("step") ?? "1")));
  const template = templateById(data.templateId)!;

  const [name, setName] = useState(t(data.templateName));
  const [profileFamily, setProfileFamily] = useState<PackFamily | undefined>(
    data.isProfile ? "profiles_beauty" : undefined,
  );
  const [toggles, setToggles] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const q of data.questions) if (!q.required && q.optionalInSetup) initial[q.key] = true;
    return initial;
  });
  const [overrides, setOverrides] = useState<NonNullable<WizardConfig["overrides"]>>({});
  const [editing, setEditing] = useState(false);
  const [audience, setAudience] = useState<Targeting["customerType"]>(data.defaults.audience);
  const [placements, setPlacements] = useState<Placement[]>(templatePlacements(template));
  const [samplePercent, setSamplePercent] = useState(data.defaults.samplePercent);
  const [paymentManualOnly, setPaymentManualOnly] = useState(data.defaults.paymentManualOnly ?? false);
  const [productsOnly, setProductsOnly] = useState(data.defaults.productsOnly ?? false);
  const [productIdsText, setProductIdsText] = useState("");
  const [rotation, setRotation] = useState(false);
  const [learnAndStop, setLearnAndStop] = useState(data.defaults.learnAndStop ?? false);
  const [smartActions, setSmartActions] = useState<string[]>([]);

  const config: WizardConfig = {
    name,
    toggles,
    overrides,
    profileFamily,
    lite: data.lite,
    audience,
    placements,
    samplePercent,
    paymentManualOnly,
    productsOnly,
    productIds: productIdsText.split(",").map((v) => v.trim()).filter(Boolean),
    rotation,
    learnAndStop,
    smartActions,
  };

  const definition = buildSurveyDefinition({
    template,
    locale: data.locale,
    region: data.region,
    lite: data.lite,
    toggles,
    overrides,
    profileFamily,
  });

  const preview = definitionToPreview(definition, {
    templateId: template.id,
    templateVersion: template.version,
    placements,
  });

  const readiness = getReadiness({
    definition,
    placements,
    maxQuestions: null,
    overActiveLimit: false,
    configBytes: new TextEncoder().encode(JSON.stringify(definition)).length,
    blockAdded: null,
    translationsComplete: true,
  });
  const blocked = readinessBlocksGoLive(readiness);

  const setStep = (n: number) => {
    const next = new URLSearchParams(params);
    next.set("step", String(n));
    setParams(next, { replace: true, preventScrollReset: true });
  };

  const togglePlacement = (placement: Placement, on: boolean) => {
    setPlacements((prev) => (on ? [...new Set([...prev, placement])] : prev.filter((p) => p !== placement)));
  };

  const audienceLabel = (value: string) =>
    t(`setup.audience_${value === "first_order" ? "first" : value === "returning" ? "returning" : "everyone"}`);

  const placementOptions: Array<{ value: Placement; labelKey: string }> = [
    { value: "thank_you", labelKey: "setup.placement_thank_you" },
    { value: "order_status", labelKey: "setup.placement_order_status" },
    ...(data.surveyLinkEnabled ? [{ value: "link" as Placement, labelKey: "setup.placement_survey_link" }] : []),
  ];

  return (
    <s-stack gap="base">
      {failureText ? <Banner tone="critical" heading={failureText} /> : null}
      <s-link href={`/app/surveys/library/${template.id}`}>{t("library.back")}</s-link>
      <s-section heading={t("setup.title")} subheading={t("setup.subtitle")} padding="none" />
      <s-text color="subdued">{t("setup.step_of", { step })}</s-text>

      {step === 1 ? (
        <Panel title={t("setup.step1_title")}>
          <s-stack gap="base">
            <s-text-field
              label={t("setup.name")}
              details={t("setup.name_help")}
              value={name}
              maxLength={LIMITS.MAX_SURVEY_NAME}
              onInput={(e: Event) => setName(fieldValue(e))}
            />

            {data.isProfile ? (
              <s-select
                label={t("setup.industry")}
                details={t("setup.industry_help")}
                value={profileFamily ?? ""}
                onChange={(e: Event) => setProfileFamily(fieldValue(e) as PackFamily)}
              >
                {data.profileFamilies.map((f) => (
                  <s-option key={f.id} value={f.id}>
                    {t(f.labelKey)}
                  </s-option>
                ))}
              </s-select>
            ) : null}

            <s-stack gap="small">
              <s-text type="strong">{t("setup.optional_questions")}</s-text>
              {data.questions.map((q) => (
                <s-box key={q.key} padding="small" border="base" borderRadius="base">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text>{t(`templates.${template.id}.${q.key}.text`)}</s-text>
                    {q.required ? (
                      <s-badge tone="neutral">{t("setup.always_included")}</s-badge>
                    ) : (
                      <s-switch
                        label={t("setup.toggle_help")}
                        checked={toggles[q.key] !== false}
                        onChange={(e: Event) => setToggles((prev) => ({ ...prev, [q.key]: checkboxChecked(e) }))}
                      />
                    )}
                  </s-stack>
                </s-box>
              ))}
            </s-stack>

            <s-button type="button" variant="secondary" onClick={() => setEditing((v) => !v)}>
              {editing ? t("setup.close_edit") : t("setup.edit_wording")}
            </s-button>
            {editing ? (
              <InlineEdits template={template} overrides={overrides} setOverrides={setOverrides} t={t} />
            ) : null}
          </s-stack>
        </Panel>
      ) : null}

      {step === 2 ? (
        <Panel title={t("setup.step2_title")}>
          <s-stack gap="base">
            <s-choice-list
              label={t("setup.audience")}
              name="audience"
              values={audience ? [audience] : []}
              onChange={(e: Event) => {
                const value = (e.currentTarget as { values?: string[] }).values?.[0];
                if (value) setAudience(value as Targeting["customerType"]);
              }}
            >
              {(["everyone", "first_order", "returning"] as const).map((value) => (
                <s-choice key={value} value={value}>
                  {audienceLabel(value)}
                </s-choice>
              ))}
            </s-choice-list>

            <s-stack gap="small">
              <s-text type="strong">{t("setup.placements")}</s-text>
              {placementOptions.map((p) => (
                <s-checkbox
                  key={p.value}
                  name={`placement-${p.value}`}
                  label={t(p.labelKey)}
                  checked={placements.includes(p.value) || undefined}
                  onChange={(e: Event) => togglePlacement(p.value, checkboxChecked(e))}
                />
              ))}
            </s-stack>

            {template.id === "delivery-ready" ? (
              <s-switch
                label={t("setup.payment_only")}
                details={t("setup.payment_only_help")}
                checked={paymentManualOnly || undefined}
                onChange={(e: Event) => setPaymentManualOnly(checkboxChecked(e))}
              />
            ) : null}

            {data.defaults.productsOnly ? (
              <s-stack gap="small">
                <s-switch
                  label={t("setup.products_only")}
                  details={t("setup.products_only_help")}
                  checked={productsOnly || undefined}
                  onChange={(e: Event) => setProductsOnly(checkboxChecked(e))}
                />
                {productsOnly ? (
                  <s-text-field
                    label={t("surveys.target_products_note", { max: LIMITS.MAX_TARGET_PRODUCTS })}
                    value={productIdsText}
                    onInput={(e: Event) => setProductIdsText(fieldValue(e))}
                  />
                ) : null}
              </s-stack>
            ) : null}

            <s-number-field
              label={t("setup.sample")}
              details={t("setup.sample_help")}
              min={1}
              max={100}
              value={String(samplePercent)}
              onInput={(e: Event) => setSamplePercent(Number(fieldValue(e)) || 100)}
            />

            <s-stack gap="small">
              <s-text type="strong">{t("setup.more_options")}</s-text>
              <s-switch
                label={t("setup.learn_stop")}
                details={t("setup.learn_stop_help")}
                checked={learnAndStop || undefined}
                onChange={(e: Event) => setLearnAndStop(checkboxChecked(e))}
              />
              <s-switch
                label={t("setup.rotation")}
                details={t("setup.rotation_help")}
                checked={rotation || undefined}
                onChange={(e: Event) => setRotation(checkboxChecked(e))}
              />
            </s-stack>
          </s-stack>
        </Panel>
      ) : null}

      {step === 3 ? (
        <Panel title={t("setup.step3_title")}>
          <s-stack gap="base">
            <s-text>
              {`${t("setup.summary")}: ${definition.questions.length} · ${audienceLabel(audience ?? "everyone")} · ${placements
                .map((p) => t(placementOptions.find((o) => o.value === p)?.labelKey ?? p))
                .join(", ")}`}
            </s-text>

            <s-stack gap="small">
              <s-text type="strong">{t("setup.ready")}</s-text>
              {readiness.map((item) => (
                <s-stack key={item.id} direction="inline" gap="small" alignItems="center">
                  <s-badge tone={item.ok ? "success" : item.blocking ? "critical" : "warning"}>
                    {item.ok ? "✓" : "!"}
                  </s-badge>
                  <s-text>{t(`ready.${item.id}`)}</s-text>
                </s-stack>
              ))}
            </s-stack>

            {data.hasSmartActions ? (
              <s-stack gap="small">
                <s-text type="strong">{t("setup.actions_title")}</s-text>
                <s-text color="subdued">{t("setup.actions_help")}</s-text>
                {data.grantedScopes.length === 0 ? (
                  <Banner tone="info" heading={t("smart_actions.title")}>
                    {t("smart_actions.no_scopes")}
                  </Banner>
                ) : (
                  data.smartActionIds.map((id) => {
                    const preset = SMART_ACTION_PRESETS[id];
                    const tag = (preset?.name ?? id).replace(":{optionKey}", ":…").replace("{optionKey}", "…");
                    const pro = data.plan !== "scale";
                    return (
                      <s-switch
                        key={id}
                        label={tag}
                        details={pro ? t("smart_actions.pro_only") : t(preset?.exampleKey ?? "smart_actions.example_order_tag", { tag })}
                        disabled={pro || undefined}
                        checked={smartActions.includes(id) || undefined}
                        onChange={(e: Event) =>
                          setSmartActions((prev) => (checkboxChecked(e) ? [...prev, id] : prev.filter((x) => x !== id)))
                        }
                      />
                    );
                  })
                )}
              </s-stack>
            ) : null}
          </s-stack>
        </Panel>
      ) : null}

      <SurveyPreview survey={preview} languages={data.languages} t={t} />

      <s-stack direction="inline" gap="small" justifyContent="space-between">
        <s-button type="button" disabled={step === 1 || undefined} onClick={() => setStep(step - 1)}>
          {t("setup.back")}
        </s-button>
        {step < 3 ? (
          <s-button type="button" variant="primary" onClick={() => setStep(step + 1)}>
            {t("setup.next")}
          </s-button>
        ) : (
          <s-stack direction="inline" gap="small">
            <Form method="post">
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="config" value={JSON.stringify(config)} />
              <input type="hidden" name="goLive" value="0" />
              <s-button type="submit">{t("setup.save_draft")}</s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="config" value={JSON.stringify(config)} />
              <input type="hidden" name="goLive" value="1" />
              <s-button type="submit" variant="primary" disabled={blocked || undefined}>
                {t("setup.go_live")}
              </s-button>
            </Form>
          </s-stack>
        )}
      </s-stack>
    </s-stack>
  );
}

function InlineEdits({
  template,
  overrides,
  setOverrides,
  t,
}: {
  template: TemplateDefinition;
  overrides: NonNullable<WizardConfig["overrides"]>;
  setOverrides: (value: NonNullable<WizardConfig["overrides"]>) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  return (
    <s-stack gap="small">
      <s-text color="subdued">{t("setup.edit_wording_help")}</s-text>
      {template.questions.map((q) => (
        <s-box key={q.key} padding="small" border="base" borderRadius="base">
          <s-stack gap="small">
            <s-text-field
              label={t(`templates.${template.id}.${q.key}.text`)}
              value={overrides[q.key]?.text ?? ""}
              onInput={(e: Event) => setOverrides({ ...overrides, [q.key]: { ...overrides[q.key], text: fieldValue(e) } })}
            />
            {q.options?.map((o) => (
              <s-text-field
                key={o.key}
                label={t(o.labelKey)}
                value={overrides[q.key]?.options?.[o.key] ?? ""}
                onInput={(e: Event) =>
                  setOverrides({
                    ...overrides,
                    [q.key]: {
                      ...overrides[q.key],
                      options: { ...overrides[q.key]?.options, [o.key]: fieldValue(e) },
                    },
                  })
                }
              />
            ))}
          </s-stack>
        </s-box>
      ))}
    </s-stack>
  );
}
