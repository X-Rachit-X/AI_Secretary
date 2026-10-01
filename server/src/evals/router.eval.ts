import { routerNode } from "../ai/router.node.js";
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
    response: "",
    images: [],
    artifacts: [],
    searchResults: undefined,
    flags: [],
    toolCalls: 0,
  } as GraphStateType;
}

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
