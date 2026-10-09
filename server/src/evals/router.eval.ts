import { routerNode, parsePlan } from "../ai/router.node.js";
import { nextInPlan } from "../ai/graph.js";
import { END } from "@langchain/langgraph";
import { UsageMeter } from "../ai/gateway.js";
import type { GraphStateType } from "../ai/state.js";
import type { CaseResult, Suite } from "./types.js";

/**
 * Live suite: router accuracy.
 *
 * This is the eval that earns its keep. The router is one prompt, and routing
 * is invisible when it goes wrong — a calendar question answered by the chat
 * agent produces a confident, plausible, entirely made-up answer. Nothing
 * errors. The only way to notice is to measure.
 *
 * Needs a model, so it is opt-in: `npm run eval -- --live`.
 *
 * The cases are chosen to cover the boundaries that actually confuse a
 * classifier, not the easy middle:
 *   - "my" questions (calendar/mail) vs general questions (chat)
 *   - "latest/today" (search) vs timeless explanation (chat)
 *   - "write me a doc" (pdf) vs "write me code" (coding)
 *   - availability phrased as a question (workspace, not chat)
 */

type RouterCase = { id: string; prompt: string; expect: string; about: string };

const CASES: RouterCase[] = [
  // ── workspace: anything about THIS user's calendar or mail ─────────────
  { id: "r.ws.agenda", prompt: "what's on my calendar today?", expect: "workspace", about: "own agenda" },
  { id: "r.ws.book", prompt: "book 30 minutes with sam tomorrow afternoon", expect: "workspace", about: "scheduling" },
  { id: "r.ws.free", prompt: "am I free at 4pm on Thursday?", expect: "workspace", about: "availability as a question" },
  { id: "r.ws.move", prompt: "move my 3pm to Friday morning", expect: "workspace", about: "rescheduling" },
  { id: "r.ws.unread", prompt: "any unread mail from my manager this week?", expect: "workspace", about: "inbox search" },
  { id: "r.ws.reply", prompt: "reply to the last email from accounts and say yes", expect: "workspace", about: "mail reply" },
  { id: "r.ws.remind", prompt: "remind me about the standup tomorrow", expect: "workspace", about: "reminder" },

  // ── chat: general knowledge, no personal data, no freshness ────────────
  { id: "r.chat.closure", prompt: "explain closures in javascript", expect: "chat", about: "timeless explanation" },
  { id: "r.chat.advice", prompt: "how should I structure a code review?", expect: "chat", about: "advice" },
  { id: "r.chat.calendar_general", prompt: "how do calendar invites work technically?", expect: "chat", about: "BOUNDARY: about calendars, not THEIR calendar" },
  { id: "r.chat.greeting", prompt: "hey there", expect: "chat", about: "greeting" },

  // ── search: needs fresh information ───────────────────────────────────
  { id: "r.search.news", prompt: "what happened in the news today?", expect: "search", about: "today" },
  { id: "r.search.price", prompt: "what's the current price of bitcoin?", expect: "search", about: "live number" },
  { id: "r.search.latest", prompt: "what's the latest version of node?", expect: "search", about: "latest" },

  // ── generation ────────────────────────────────────────────────────────
  { id: "r.pdf.guide", prompt: "make a pdf guide to postgres indexing", expect: "pdf", about: "explicit pdf" },
  { id: "r.pdf.report", prompt: "write me a report document on remote work", expect: "pdf", about: "document" },
  { id: "r.ppt.deck", prompt: "create a deck about AI in healthcare", expect: "ppt", about: "deck" },
  { id: "r.ppt.slides", prompt: "8 slides on our Q3 results", expect: "ppt", about: "slides" },
  { id: "r.code.build", prompt: "build me a landing page for a coffee shop", expect: "coding", about: "build" },
  { id: "r.code.review", prompt: "review this function for bugs: function f(a){return a.map(x=>x*2)}", expect: "coding", about: "review" },
  { id: "r.image.draw", prompt: "draw a cat astronaut in watercolour", expect: "image", about: "image" },
];

/** Minimal state: only what routerNode actually reads. */
function stateFor(prompt: string, meter: UsageMeter): GraphStateType {
  return {
    prompt,
    userId: "eval-user",
    conversationId: "eval-conversation",
    history: [],
    file: undefined,
    onProgress: () => {},
    meter,
    turnId: "eval-turn",
    suspicious: false,
    agent: "auto",
    plan: [],
    planStep: 0,
    response: "",
    images: [],
    artifacts: [],
    searchResults: undefined,
    flags: [],
    toolCalls: 0,
  } as GraphStateType;
}


/**
 * Offline suite: the plan parser.
 *
 * These are the rules that keep a multi-agent plan executable, and all of them
 * are pure string handling — so they are checkable with no model and no network.
 * Worth having because a bad plan does not throw: it either ends the turn early
 * or loops, and both look like "the agent is being weird".
 */
const PLAN_CASES: Array<{
  id: string;
  about: string;
  reply: string;
  expect: string[];
}> = [
  {
    id: "plan.single",
    about: "one agent stays one agent",
    reply: "chat",
    expect: ["chat"],
  },
  {
    id: "plan.pair",
    about: "a two-step plan is preserved in order",
    reply: "search -> ppt",
    expect: ["search", "ppt"],
  },
  {
    id: "plan.noisy_reply",
    about: "models answer with punctuation and prose; only valid names survive",
    reply: "Plan: search -> ppt. (research first)",
    expect: ["search", "ppt"],
  },
  {
    id: "plan.search_needs_writer",
    about:
      "RULE: a trailing search cannot answer, so chat is appended",
    reply: "search",
    expect: ["search", "chat"],
  },
  {
    id: "plan.search_bad_consumer",
    about:
      "RULE: search -> image is nonsense (image cannot read research), corrected to chat",
    reply: "search -> image",
    expect: ["search", "chat"],
  },
  {
    id: "plan.dedupe",
    about: "RULE: duplicates are dropped so a plan cannot loop",
    reply: "chat -> chat",
    expect: ["chat"],
  },
  {
    id: "plan.capped",
    about: "RULE: a long plan is capped, because every step is billed",
    reply: "search -> chat -> pdf -> ppt -> coding -> image",
    expect: ["search", "chat", "pdf"],
  },
  {
    id: "plan.garbage",
    about: "DEGRADE: an unusable reply falls back to chat, never to nothing",
    reply: "I am not sure what you mean",
    expect: ["chat"],
  },
  {
    id: "plan.empty",
    about: "DEGRADE: an empty reply falls back to chat",
    reply: "",
    expect: ["chat"],
  },
  {
    id: "plan.rejects_unknown",
    about: "an agent name that does not exist is dropped, not executed",
    reply: "chat -> translator",
    expect: ["chat"],
  },
];


/**
 * Walk a plan the way the graph does: ask nextInPlan, "run" the node, advance,
 * repeat. This asserts the two properties that matter — the agents fire in the
 * right ORDER, and the walk TERMINATES.
 *
 * A plan that never reaches END would hang a real request, so the step cap is
 * asserted here rather than trusted.
 */
function walkPlan(plan: string[]): string[] {
  const visited: string[] = [];
  let step = 0;

  // Bounded so a broken rule fails the test instead of hanging the suite.
  for (let guard = 0; guard < 20; guard += 1) {
    const next = nextInPlan({ plan, planStep: step } as never);
    if (next === END) break;
    visited.push(String(next));
    step += 1;
  }

  return visited;
}

const WALK_CASES: Array<{ id: string; about: string; plan: string[]; expect: string[] }> = [
  {
    id: "walk.single",
    about: "a one-step plan runs once and ends",
    plan: ["chat"],
    expect: ["chat"],
  },
  {
    id: "walk.pair_in_order",
    about: "a two-step plan runs both, in order",
    plan: ["search", "ppt"],
    expect: ["search", "ppt"],
  },
  {
    id: "walk.terminates_at_cap",
    about:
      "SAFETY: a plan longer than MAX_PLAN_STEPS stops at the cap instead of running on",
    plan: ["search", "chat", "pdf", "ppt", "coding"],
    expect: ["search", "chat", "pdf"],
  },
  {
    id: "walk.empty_plan_ends",
    about: "DEGRADE: an empty plan ends the turn rather than hanging",
    plan: [],
    expect: [],
  },
  {
    id: "walk.unknown_node_ends",
    about:
      "SAFETY: a plan naming a node that does not exist ends the turn rather than hanging the graph",
    plan: ["chat", "nonexistent"],
    expect: ["chat"],
  },
];

export const planSuite: Suite = {
  name: "router-plans",
  kind: "offline",
  about:
    "plans parse safely and execute in order, and every plan terminates",
  run: async () => [
    ...WALK_CASES.map((testCase) => {
      const actual = walkPlan(testCase.plan);
      const passed = JSON.stringify(actual) === JSON.stringify(testCase.expect);

      return {
        id: testCase.id,
        about: testCase.about,
        passed,
        score: passed ? 1 : 0,
        expected: testCase.expect,
        actual,
        note: passed
          ? undefined
          : `[${testCase.plan.join(",")}] walked as [${actual.join(",")}]`,
      };
    }),
    ...PLAN_CASES.map((testCase) => {
      const actual = parsePlan(testCase.reply);
      const passed =
        JSON.stringify(actual) === JSON.stringify(testCase.expect);

      return {
        id: testCase.id,
        about: testCase.about,
        passed,
        score: passed ? 1 : 0,
        expected: testCase.expect,
        actual,
        note: passed ? undefined : `"${testCase.reply}" produced ${actual.join(" -> ")}`,
      };
    }),
  ],
};

export const routerSuite: Suite = {
  name: "router",
  kind: "live",
  about: "does the router send each prompt to the right agent",
  run: async () => {
    const results: CaseResult[] = [];

    for (const testCase of CASES) {
      const meter = new UsageMeter();

      try {
        const decision = await routerNode(stateFor(testCase.prompt, meter));
        const actual = decision.agent;

        results.push({
          id: testCase.id,
          about: testCase.about,
          passed: actual === testCase.expect,
          score: actual === testCase.expect ? 1 : 0,
          expected: testCase.expect,
          actual,
          note:
            actual === testCase.expect
              ? undefined
              : `"${testCase.prompt}" routed to ${actual}`,
        });
      } catch (error) {
        results.push({
          id: testCase.id,
          about: testCase.about,
          passed: false,
          score: 0,
          expected: testCase.expect,
          actual: "error",
          note: (error as Error).message,
        });
      }
    }

    return results;
  },
};

/**
 * Also exported so the file-attachment rules can be checked offline: those two
 * decisions are made from the MIME type with no model call, which means they
 * are cheap to assert and must never regress.
 */
export const routerOfflineSuite: Suite = {
  name: "router-attachments",
  kind: "offline",
  about: "an attachment picks the agent deterministically, with no model call",
  run: async () => {
    const meter = new UsageMeter();

    const imageState = {
      ...stateFor("what is this?", meter),
      file: {
        path: "/tmp/x.png",
        mimetype: "image/png",
        originalname: "x.png",
        size: 1,
      },
    } as GraphStateType;

    const pdfState = {
      ...stateFor("summarise this", meter),
      file: {
        path: "/tmp/x.pdf",
        mimetype: "application/pdf",
        originalname: "x.pdf",
        size: 1,
      },
    } as GraphStateType;

    // An explicit UI choice must be honoured without asking a model.
    const pickedState = {
      ...stateFor("anything", meter),
      agent: "ppt",
    } as GraphStateType;

    const image = await routerNode(imageState);
    const pdf = await routerNode(pdfState);
    const picked = await routerNode(pickedState);

    const checks: Array<[string, string, unknown, string]> = [
      ["ra.image", "an image upload routes to vision", image.agent, "vision"],
      ["ra.pdf", "a pdf upload routes to docqa", pdf.agent, "docqa"],
      [
        "ra.explicit",
        "an agent chosen in the UI is honoured with no model call",
        picked.agent,
        "ppt",
      ],
    ];

    const results: CaseResult[] = checks.map(([id, about, actual, expect]) => ({
      id,
      about,
      passed: actual === expect,
      score: actual === expect ? 1 : 0,
      expected: expect,
      actual,
    }));

    results.push({
      id: "ra.no_model_call",
      about: "none of the three made a model call",
      passed: meter.usage.modelCalls === 0,
      score: meter.usage.modelCalls === 0 ? 1 : 0,
      expected: 0,
      actual: meter.usage.modelCalls,
    });

    return results;
  },
};
