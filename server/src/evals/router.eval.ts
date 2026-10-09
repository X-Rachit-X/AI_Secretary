import { routerNode, pickAgent } from "../ai/router.node.js";
import { UsageMeter } from "../ai/gateway.js";
import type { GraphStateType } from "../ai/state.js";
import type { CaseResult, Suite } from "./types.js";

/**
 * Router evals.
 *
 * The router is one prompt, and routing fails invisibly: a calendar question
 * answered by the chat agent produces a confident, fluent, entirely invented
 * answer. Nothing errors and a typecheck passes. The only way to notice is to
 * measure.
 *
 * Three suites:
 *   router-parse        offline — the reply parser
 *   router-attachments  offline — the file-driven rules
 *   router              live    — classification accuracy
 */

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
    flags: [],
    toolCalls: 0,
  } as GraphStateType;
}

// ── Offline: the reply parser ───────────────────────────────────────────────

const PARSE_CASES: Array<{
  id: string;
  about: string;
  reply: string;
  expect: string;
}> = [
  {
    id: "parse.clean",
    about: "a bare handler name is taken as-is",
    reply: "studio",
    expect: "studio",
  },
  {
    id: "parse.punctuated",
    about: "models answer with a full stop often enough to matter",
    reply: "Studio.",
    expect: "studio",
  },
  {
    id: "parse.prefixed",
    about: '"handler: workspace" is a common shape',
    reply: "handler: workspace",
    expect: "workspace",
  },
  {
    id: "parse.prose",
    about: "a whole sentence still yields the first valid name",
    reply: "This should go to the studio handler I think",
    expect: "studio",
  },
  {
    id: "parse.unknown_falls_back",
    about:
      "DEGRADE: a name that is not a handler falls back to chat, never to nothing",
    reply: "translator",
    expect: "chat",
  },
  {
    id: "parse.empty_falls_back",
    about: "DEGRADE: an empty reply falls back to chat",
    reply: "",
    expect: "chat",
  },
  {
    id: "parse.rejects_tool_names",
    about:
      "pdf/ppt/search are TOOLS now, not handlers — the router must never return one",
    reply: "ppt",
    expect: "chat",
  },
];

export const routerParseSuite: Suite = {
  name: "router-parse",
  kind: "offline",
  about: "the router reply parser tolerates prose and degrades to chat",
  run: async () =>
    PARSE_CASES.map((testCase) => {
      const actual = pickAgent(testCase.reply);
      const passed = actual === testCase.expect;

      return {
        id: testCase.id,
        about: testCase.about,
        passed,
        score: passed ? 1 : 0,
        expected: testCase.expect,
        actual,
        note: passed ? undefined : `"${testCase.reply}" produced ${actual}`,
      };
    }),
};

// ── Offline: the file-driven rules ──────────────────────────────────────────

export const routerOfflineSuite: Suite = {
  name: "router-attachments",
  kind: "offline",
  about: "an attachment picks the handler deterministically, with no model call",
  run: async () => {
    const meter = new UsageMeter();

    const withFile = (mimetype: string, name: string) =>
      ({
        ...stateFor("what is this?", meter),
        file: { path: `/tmp/${name}`, mimetype, originalname: name, size: 1 },
      }) as GraphStateType;

    const image = await routerNode(withFile("image/png", "x.png"));
    const pdf = await routerNode(withFile("application/pdf", "x.pdf"));

    // An explicit UI choice must be honoured without asking a model.
    const picked = await routerNode({
      ...stateFor("anything", meter),
      agent: "studio",
    } as GraphStateType);

    const checks: Array<[string, string, unknown, string]> = [
      ["ra.image", "an image upload routes to vision", image.agent, "vision"],
      ["ra.pdf", "a pdf upload routes to docqa", pdf.agent, "docqa"],
      [
        "ra.explicit",
        "a handler chosen in the UI is honoured with no model call",
        picked.agent,
        "studio",
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

// ── Live: classification accuracy ───────────────────────────────────────────

type RouterCase = { id: string; prompt: string; expect: string; about: string };

/**
 * These target the boundaries that actually confuse a classifier, not the easy
 * middle. The hardest is chat vs studio: "explain X" needs no tool and
 * "what's the latest X" does, and the words barely differ.
 */
const CASES: RouterCase[] = [
  // workspace — anything about THIS user's own data
  { id: "r.ws.agenda", prompt: "what's on my calendar today?", expect: "workspace", about: "own agenda" },
  { id: "r.ws.book", prompt: "book 30 minutes with sam tomorrow afternoon", expect: "workspace", about: "scheduling" },
  { id: "r.ws.free", prompt: "am I free at 4pm on Thursday?", expect: "workspace", about: "availability as a question" },
  { id: "r.ws.unread", prompt: "any unread mail from my manager this week?", expect: "workspace", about: "inbox search" },
  { id: "r.ws.reply", prompt: "reply to the last email from accounts and say yes", expect: "workspace", about: "mail reply" },
  { id: "r.ws.remind", prompt: "remind me about the standup tomorrow", expect: "workspace", about: "reminder" },

  // chat — general knowledge, no tool, nothing current
  { id: "r.chat.closure", prompt: "explain closures in javascript", expect: "chat", about: "timeless explanation" },
  { id: "r.chat.advice", prompt: "how should I structure a code review?", expect: "chat", about: "advice" },
  { id: "r.chat.compare", prompt: "should I use postgres or mongodb?", expect: "chat", about: "opinion, no tool needed" },
  { id: "r.chat.calendar_general", prompt: "how do calendar invites work technically?", expect: "chat", about: "BOUNDARY: about calendars, not THEIR calendar" },
  { id: "r.chat.greeting", prompt: "hey there", expect: "chat", about: "greeting" },

  // studio — needs a tool: research, or make something
  { id: "r.studio.news", prompt: "what happened in the news today?", expect: "studio", about: "needs current info" },
  { id: "r.studio.price", prompt: "what's the current price of bitcoin?", expect: "studio", about: "live number" },
  { id: "r.studio.latest", prompt: "what's the latest version of node?", expect: "studio", about: "BOUNDARY: 'latest' implies a tool" },
  { id: "r.studio.pdf", prompt: "make a pdf guide to postgres indexing", expect: "studio", about: "document" },
  { id: "r.studio.deck", prompt: "create a deck about AI in healthcare", expect: "studio", about: "deck" },
  { id: "r.studio.chain", prompt: "research the latest on RAG and make a deck", expect: "studio", about: "research then make — ONE handler now, not a plan" },
  { id: "r.studio.code", prompt: "build me a landing page for a coffee shop", expect: "studio", about: "build" },
  { id: "r.studio.review", prompt: "review this function for bugs: function f(a){return a.map(x=>x*2)}", expect: "studio", about: "code review" },
  { id: "r.studio.image", prompt: "draw a cat astronaut in watercolour", expect: "studio", about: "image" },
];

export const routerSuite: Suite = {
  name: "router",
  kind: "live",
  about: "does the router send each prompt to the right handler",
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
