/**
 * "Never lose the answer": an answer set the block could not send within its
 * retry budget is kept in the extension's storage and sent the next time the
 * block loads for that order. The real `useMultiSurvey` hook runs in Preact
 * against a fake API, so the budget is not waited out.
 */
import "../helpers/dom-globals";

import { h, render } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import { pendingKey, useMultiSurvey, type MultiSurveyApi, type PendingStore } from "../../extensions/shared/src/use-multi-survey";
import type { SubmitResult, SurveyConfigV2 } from "../../extensions/shared/src/survey-logic";

const ORDER = "gid://shopify/OrderIdentity/5551234";

const config: SurveyConfigV2 = {
  enabled: true,
  orderId: "5551234",
  placement: "thank_you",
  alreadyAnswered: false,
  survey: {
    id: "survey-1",
    version: 2,
    placements: ["thank_you"],
    layout: "all",
    title: "Quick question",
    intro: null,
    buttonLabel: "Submit",
    thankYouText: "Thanks!",
    questions: [
      {
        id: "q1",
        type: "single_choice",
        text: "Where?",
        textMultiline: false,
        required: true,
        randomizeOptions: false,
        allowOther: false,
        options: [
          { id: "a", label: "A", isOther: false },
          { id: "b", label: "B", isOther: false },
        ],
      },
    ],
  },
};

function memoryStore(): PendingStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    read: async (key) => data.get(key) ?? null,
    write: async (key, value) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

type State = ReturnType<typeof useMultiSurvey>;

function mount(api: MultiSurveyApi) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const latest: { state: State | null } = { state: null };
  function Probe() {
    latest.state = useMultiSurvey(ORDER, "thank_you", api);
    return null;
  }
  render(h(Probe, null), root);
  return { latest, unmount: () => render(null, root) };
}

// Preact runs effects after paint, so give each step time to land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function api(over: Partial<MultiSurveyApi> & { submits: unknown[] }): MultiSurveyApi {
  return {
    fetchSurvey: async () => config,
    submitAnswers: async (params) => {
      over.submits.push(params);
      return (over.submitAnswers ? over.submitAnswers(params) : { ok: true, counted: true }) as Promise<SubmitResult | null>;
    },
    t: (_key, fallback) => fallback,
    ...over,
  } as MultiSurveyApi;
}

describe("an answer that could not be sent", () => {
  it("is kept when every attempt failed, then sent on the next load and the survey is not asked again", async () => {
    const store = memoryStore();
    const submits: unknown[] = [];
    const first = mount(api({ storage: store, submits, submitAnswers: async () => null }));
    cleanup.push(first.unmount);
    await settle();
    expect(first.latest.state?.phase).toBe("asking");
    first.latest.state?.setAnswer("q1", { optionIds: ["b"] });
    await settle();
    // The buyer sees no error; the block just closes.
    expect(first.latest.state?.phase).toBe("hidden");
    expect(store.data.get(pendingKey(ORDER))).toMatchObject({
      surveyId: "survey-1",
      surveyVersion: 2,
      placement: "thank_you",
      answers: [{ questionId: "q1", optionIds: ["b"] }],
    });
    first.unmount();

    // A reload of the page: the kept answer goes first, and the survey stays hidden.
    const later: unknown[] = [];
    const second = mount(api({ storage: store, submits: later }));
    cleanup.push(second.unmount);
    await settle();
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ surveyId: "survey-1", orderId: ORDER, answers: [{ questionId: "q1", optionIds: ["b"] }] });
    expect(store.data.has(pendingKey(ORDER))).toBe(false);
    expect(second.latest.state?.phase).toBe("hidden");
  });

  it("is not kept when the server refused it outright", async () => {
    const store = memoryStore();
    const submits: unknown[] = [];
    const page = mount(api({ storage: store, submits, submitAnswers: async () => ({ ok: false, counted: false, rejected: true }) }));
    cleanup.push(page.unmount);
    await settle();
    page.latest.state?.setAnswer("q1", { optionIds: ["a"] });
    await settle();
    expect(page.latest.state?.phase).toBe("hidden");
    expect(store.data.size).toBe(0);
  });

  it("is dropped once the order has answered elsewhere", async () => {
    const store = memoryStore();
    await store.write(pendingKey(ORDER), { surveyId: "survey-1", placement: "thank_you", answers: [], at: Date.now() });
    const submits: unknown[] = [];
    // Still unreachable for the kept answer, but the config says the order answered.
    const page = mount(
      api({
        storage: store,
        submits,
        submitAnswers: async () => null,
        fetchSurvey: async () => ({ ...config, alreadyAnswered: true }),
      }),
    );
    cleanup.push(page.unmount);
    await settle();
    expect(page.latest.state?.phase).toBe("hidden");
    expect(store.data.size).toBe(0);
  });

  it("works without a storage API, as before", async () => {
    const submits: unknown[] = [];
    const page = mount(api({ submits, submitAnswers: async () => null }));
    cleanup.push(page.unmount);
    await settle();
    page.latest.state?.setAnswer("q1", { optionIds: ["a"] });
    await settle();
    expect(page.latest.state?.phase).toBe("hidden");
  });
});
