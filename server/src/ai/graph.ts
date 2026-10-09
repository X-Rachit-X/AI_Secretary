import { END, START, StateGraph } from "@langchain/langgraph";
import {
  GraphState,
  MAX_PLAN_STEPS,
  type AgentName,
  type GraphStateType,
} from "./state.js";
import { routerNode } from "./router.node.js";
import { chatAgent } from "./agents/chat.agent.js";
import { searchAgent } from "./agents/search.agent.js";
import { codingAgent } from "./agents/coding.agent.js";
import { pdfAgent } from "./agents/pdf.agent.js";
import { pptAgent } from "./agents/ppt.agent.js";
import { imageAgent } from "./agents/image.agent.js";
import { visionAgent } from "./agents/vision.agent.js";
import { docqaAgent } from "./agents/docqa.agent.js";
import { workspaceAgent } from "./agents/workspace.agent.js";

/**
 * The supervisor graph.
 *
 *                      ┌──────────┐
 *           START ───▶ │  router  │  writes state.plan, e.g. ["search","ppt"]
 *                      └────┬─────┘
 *                           │
 *                    ┌──────▼───────┐
 *              ┌────▶│ nextInPlan() │────▶ END   when the plan is exhausted
 *              │     └──────┬───────┘
 *              │            │ plan[planStep]
 *              │   ┌────────┴─────────────────────────────┬─────────┐
 *              │   ▼            ▼        ▼       ▼        ▼         ▼
 *              │ chat        search    coding   pdf/ppt  vision   workspace
 *              │   │            │        │       │        │         │
 *              └───┴────────────┴────────┴───────┴────────┴─────────┘
 *                         every agent advances the plan by one
 *
 * ── Why a plan rather than one agent ────────────────────────────────────────
 *
 * The first version picked exactly one agent and every node went straight to
 * END — with one hardcoded exception, `search -> chat`, so that a web search
 * could be turned into a cited answer.
 *
 * That exception was the design telling on itself. Real requests sometimes need
 * two agents:
 *
 *   "research the latest on RAG and make a deck"   -> ["search", "ppt"]
 *   "what's the newest Node release?"              -> ["search", "chat"]
 *   "write a PDF on our Q3 numbers from the web"   -> ["search", "pdf"]
 *
 * With a one-agent router the first of those is impossible: you get a deck with
 * no research, or research with no deck.
 *
 * So the router returns an ORDERED LIST, and routing became a single rule —
 * "run plan[planStep], then advance" — applied uniformly from the router and
 * from every agent. The special case disappeared: `search -> chat` is now just
 * the plan `["search", "chat"]`, with no edge dedicated to it.
 *
 * This is the smallest change that makes multi-agent requests work. It is
 * deliberately NOT a re-planning supervisor that reconsiders after every step:
 * that costs a model call per step and can loop. A plan decided once, capped at
 * MAX_PLAN_STEPS, is predictable and cheap, and covers the cases that actually
 * come up. See docs/13-DECISIONS.md ADR 16.
 */

/** Node name -> the function that runs it. Adding an agent starts here. */
const AGENT_NODES = {
  chat: chatAgent,
  search: searchAgent,
  coding: codingAgent,
  pdf: pdfAgent,
  ppt: pptAgent,
  image: imageAgent,
  vision: visionAgent,
  docqa: docqaAgent,
  workspace: workspaceAgent,
} as const;

export const AGENT_NAMES = Object.keys(AGENT_NODES) as AgentName[];

type AgentFn = (state: GraphStateType) => Promise<Record<string, unknown>>;

/**
 * Wrap an agent so it advances the plan when it finishes.
 *
 * Done here rather than inside each agent on purpose: the nine agent files stay
 * simple functions of `state -> partial state` and know nothing about plans.
 * Adding a tenth agent needs no plan-awareness at all.
 */
function withPlanAdvance(agent: AgentFn): AgentFn {
  return async (state) => ({ ...(await agent(state)), planStep: 1 });
}

/**
 * The single routing rule, used by the router and by every agent.
 *
 * Reads the next entry in the plan; END when the plan is finished. Pure: it
 * only reads state, because a conditional edge must not have side effects.
 */
export function nextInPlan(state: GraphStateType): AgentName | typeof END {
  const plan = state.plan ?? [];
  const step = state.planStep ?? 0;

  if (step >= plan.length || step >= MAX_PLAN_STEPS) return END;

  const next = plan[step];

  // A plan entry that is not a real node would hang the graph, so fall back to
  // ending the turn rather than trusting the router's output blindly.
  return next && next in AGENT_NODES ? next : END;
}

/**
 * Destination map. LangGraph validates the wiring against it at compile time,
 * which is why it is spelled out rather than generated: the literal keys are
 * what let the compiler check that `nextInPlan` can only return a real node.
 */
const ROUTE_MAP = {
  chat: "chat",
  search: "search",
  coding: "coding",
  pdf: "pdf",
  ppt: "ppt",
  image: "image",
  vision: "vision",
  docqa: "docqa",
  workspace: "workspace",
  [END]: END,
} as const;

/**
 * Nodes are registered one by one rather than in a loop.
 *
 * `addNode` is fluent and each call widens the builder's TYPE with the new node
 * name, which is how LangGraph type-checks edge destinations. A loop discards
 * those return values, so the compiler would only know about "router" and every
 * edge below would fail to type. Nine explicit lines buy real checking.
 */
const builder = new StateGraph(GraphState)
  .addNode("router", routerNode)
  .addNode("chat", withPlanAdvance(AGENT_NODES.chat))
  .addNode("search", withPlanAdvance(AGENT_NODES.search))
  .addNode("coding", withPlanAdvance(AGENT_NODES.coding))
  .addNode("pdf", withPlanAdvance(AGENT_NODES.pdf))
  .addNode("ppt", withPlanAdvance(AGENT_NODES.ppt))
  .addNode("image", withPlanAdvance(AGENT_NODES.image))
  .addNode("vision", withPlanAdvance(AGENT_NODES.vision))
  .addNode("docqa", withPlanAdvance(AGENT_NODES.docqa))
  .addNode("workspace", withPlanAdvance(AGENT_NODES.workspace));

builder.addEdge(START, "router");

/**
 * One rule, applied from the router and from every agent.
 *
 * This is the part worth noticing: the whole graph has a single edge shape.
 * Before, each agent had its own `addEdge(name, END)` plus one special
 * `search -> chat`. Now every node asks the same question — "what is next in
 * the plan?" — so adding an agent means registering a node and nothing else.
 */
for (const source of ["router", ...AGENT_NAMES] as const) {
  builder.addConditionalEdges(source, nextInPlan, ROUTE_MAP);
}

/**
 * Compiled once at import time. Compilation validates the node and edge wiring,
 * so a typo in a destination name fails at boot rather than mid-conversation.
 */
export const graph = builder.compile();

/** Everything the UI needs to render the agent picker. Single source of truth. */
export const AGENT_CATALOG: Array<{
  id: AgentName | "auto";
  label: string;
  hint: string;
}> = [
  { id: "auto", label: "Auto", hint: "Let the router pick the right agents" },
  { id: "chat", label: "Chat", hint: "General questions and explanations" },
  { id: "workspace", label: "Calendar & Mail", hint: "Your meetings and inbox" },
  { id: "search", label: "Web search", hint: "Fresh information with citations" },
  { id: "coding", label: "Code", hint: "Build, review, debug" },
  { id: "pdf", label: "PDF", hint: "Generate a PDF document" },
  { id: "ppt", label: "Slides", hint: "Generate a PowerPoint deck" },
  { id: "image", label: "Image", hint: "Generate a picture" },
];
