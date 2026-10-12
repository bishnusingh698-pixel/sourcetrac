/**
 * The 12 ready-made survey templates (plan Appendix A).
 *
 * Each is fully editable after choosing it. Default text matches the glossary
 * and tone in the plan, so it is written literally here rather than translated:
 * the template names and descriptions are shown to the merchant and are
 * translated via i18n keys in the picker, while the survey text itself is what
 * the merchant will edit.
 *
 * Option ids are stable slugs derived from the label, so a template's answers
 * aggregate consistently if the merchant keeps the defaults.
 */

import type { SurveyDefinition, SurveyQuestionDef } from "./survey-rules";

export type SurveyTemplate = {
  id: string;
  /** i18n key for the picker card title. */
  nameKey: string;
  /** i18n key for the one-line description. */
  descriptionKey: string;
  /** True for the "How did you hear about us?" template (channel report). */
  channelReport?: boolean;
  survey: SurveyDefinition;
};

function q(question: SurveyQuestionDef): SurveyQuestionDef {
  return question;
}

function opts(...labels: string[]): { id: string; label: string }[] {
  return labels.map((label) => ({
    id: label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40),
    label,
  }));
}

export const SURVEY_TEMPLATES: SurveyTemplate[] = [
  {
    id: "how-did-you-hear",
    nameKey: "templates.how_did_you_hear.name",
    descriptionKey: "templates.how_did_you_hear.description",
    channelReport: true,
    survey: {
      name: "How did you hear about us?",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "single_choice",
          text: "How did you first hear about us?",
          required: true,
          randomizeOptions: true,
          allowOther: true,
          options: opts(
            "Instagram",
            "Facebook",
            "YouTube",
            "Google search",
            "Friend or family",
            "Influencer or creator",
            "Online ad",
          ),
        }),
        q({
          id: "q2",
          type: "text",
          text: "Which creator or account?",
          placeholder: "Name or @handle",
          required: false,
          textMultiline: false,
          showIf: {
            questionId: "q1",
            optionIds: opts("Influencer or creator", "Instagram", "YouTube").map((o) => o.id),
          },
        }),
      ],
    },
  },
  {
    id: "nps",
    nameKey: "templates.nps.name",
    descriptionKey: "templates.nps.description",
    survey: {
      name: "Net Promoter Score (NPS)",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "nps",
          text: "How likely are you to recommend us to a friend?",
          required: true,
        }),
        q({
          id: "q2",
          type: "text",
          text: "What's the main reason for your score?",
          required: false,
          textMultiline: true,
        }),
      ],
    },
  },
  {
    id: "checkout-experience",
    nameKey: "templates.checkout_experience.name",
    descriptionKey: "templates.checkout_experience.description",
    survey: {
      name: "Checkout experience",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "rating_5",
          text: "How easy was it to place your order?",
          required: true,
        }),
        q({
          id: "q2",
          type: "text",
          text: "What could we make easier?",
          required: false,
          textMultiline: true,
          showIf: { questionId: "q1", min: 1, max: 3 },
        }),
      ],
    },
  },
  {
    id: "why-buy-today",
    nameKey: "templates.why_buy_today.name",
    descriptionKey: "templates.why_buy_today.description",
    survey: {
      name: "Why did you buy today?",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "multi_choice",
          text: "What made you decide to buy today?",
          required: true,
          maxSelections: 2,
          allowOther: true,
          options: opts(
            "Good price or sale",
            "Product quality",
            "Reviews",
            "Fast delivery",
            "It was a gift",
            "Recommended to me",
          ),
        }),
      ],
    },
  },
  {
    id: "what-almost-stopped-you",
    nameKey: "templates.what_almost_stopped_you.name",
    descriptionKey: "templates.what_almost_stopped_you.description",
    survey: {
      name: "What almost stopped you?",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "single_choice",
          text: "Did anything almost stop you from ordering?",
          required: false,
          allowOther: true,
          options: opts(
            "Nothing, it was easy",
            "Price",
            "Shipping cost",
            "Delivery time",
            "Not sure about size or fit",
            "Not sure the store was trustworthy",
          ),
        }),
      ],
    },
  },
  {
    id: "gift-or-yourself",
    nameKey: "templates.gift_or_yourself.name",
    descriptionKey: "templates.gift_or_yourself.description",
    survey: {
      name: "Gift or for yourself?",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "single_choice",
          text: "Who is this order for?",
          required: true,
          options: opts("Myself", "A gift for someone", "Both"),
        }),
      ],
    },
  },
  {
    id: "first-time-vs-returning",
    nameKey: "templates.first_time_vs_returning.name",
    descriptionKey: "templates.first_time_vs_returning.description",
    survey: {
      name: "First-time vs returning",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "satisfaction_5",
          text: "How happy are you with your previous orders from us?",
          required: true,
        }),
        q({
          id: "q2",
          type: "text",
          text: "We're sorry. What went wrong?",
          required: false,
          textMultiline: true,
          showIf: {
            questionId: "q1",
            optionIds: ["dissatisfied", "very_dissatisfied"],
          },
        }),
      ],
    },
  },
  {
    id: "what-next",
    nameKey: "templates.what_next.name",
    descriptionKey: "templates.what_next.description",
    survey: {
      name: "What should we make next?",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "text",
          text: "What product would you love us to make next?",
          required: false,
          textMultiline: true,
        }),
      ],
    },
  },
  {
    id: "did-you-compare",
    nameKey: "templates.did_you_compare.name",
    descriptionKey: "templates.did_you_compare.description",
    survey: {
      name: "Did you compare other stores?",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "yes_no",
          text: "Did you compare us with other stores before ordering?",
          required: true,
        }),
        q({
          id: "q2",
          type: "text",
          text: "Which store or brand did you compare us with?",
          required: false,
          textMultiline: false,
          showIf: { questionId: "q1", optionIds: ["yes"] },
        }),
      ],
    },
  },
  {
    id: "csat",
    nameKey: "templates.csat.name",
    descriptionKey: "templates.csat.description",
    survey: {
      name: "Customer satisfaction (CSAT)",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "satisfaction_5",
          text: "How satisfied are you with your shopping experience?",
          required: true,
        }),
        q({
          id: "q2",
          type: "text",
          text: "Anything we could do better?",
          required: false,
          textMultiline: true,
        }),
      ],
    },
  },
  {
    id: "how-often",
    nameKey: "templates.how_often.name",
    descriptionKey: "templates.how_often.description",
    survey: {
      name: "How often do you buy this?",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "dropdown",
          text: "How often do you buy products like this?",
          required: false,
          options: opts("This is my first time", "A few times a year", "About once a month", "Every week"),
        }),
      ],
    },
  },
  {
    id: "delivery-expectations",
    nameKey: "templates.delivery_expectations.name",
    descriptionKey: "templates.delivery_expectations.description",
    survey: {
      name: "Delivery expectations",
      title: "Quick question",
      intro: "Your answer helps us improve. It takes 10 seconds.",
      buttonLabel: "Submit",
      thankYouText: "Thanks for your feedback!",
      layout: "all",
      questions: [
        q({
          id: "q1",
          type: "single_choice",
          text: "When do you need your order?",
          required: false,
          options: opts("As soon as possible", "Within a week", "No rush"),
        }),
      ],
    },
  },
];

export function findTemplate(id: string): SurveyTemplate | undefined {
  return SURVEY_TEMPLATES.find((t) => t.id === id);
}
