import { END, START, StateGraph } from "@langchain/langgraph";
import { GraphState, type AgentName, type GraphStateType } from "./state.js";
import { routerNode } from "./router.node.js";
import { chatAgent } from "./agents/chat.agent.js";
import { studioAgent } from "./agents/studio.agent.js";
import { visionAgent } from "./agents/vision.agent.js";
import { docqaAgent } from "./agents/docqa.agent.js";
import { workspaceAgent } from "./agents/workspace.agent.js";

/**
 * The supervisor graph.
 *
 *                    ┌──────────┐
 *         START ───▶ │  router  │
 *                    └────┬─────┘
 *                         │ conditional edge on state.agent
 *        ┌────────┬───────┴────┬──────────┬──────────┐
 *        ▼        ▼            ▼          ▼          ▼
 *      chat    studio      workspace   vision     docqa
 *        │        │            │          │          │
 *        └────────┴────────────┴──────────┴──────────┘
 *                              ▼
 *                             END
 *
 * ── Five nodes, and why it is not nine ──────────────────────────────────────
 *
 * It used to be nine, with `search`, `pdf`, `ppt`, `image` and `coding` as
 * separate nodes. Then a plan mechanism was bolted on so that one request could
 * use two of them in order.
 *
 * Both of those were the wrong shape. Each of those five did exactly "call a
 * model once, parse, render, return" — no loop, no choice. **An agent is
 * something that decides.** They decided nothing, so the graph was forced to
 * decide for them, in advance, from the prompt alone.
 *
 * They are tools now, and `studio` is a ReAct loop that calls them. The loop
 * sees each result before choosing the next step, so "research X and make a
 * deck" works — and an empty search leads to the model saying so, rather than
 * producing a document that pretends to be researched.
 *
 * Deleted along the way: `state.plan`, `state.planStep`, `parsePlan` with its
 * four correction rules, `nextInPlan`, `withPlanAdvance`, and four graph nodes.
 * The routing table below is the whole of the routing logic again.
 *
 * ── What is still a node, and why ───────────────────────────────────────────
 *
 *   chat       one-shot. A plain question should not pay for a loop that
 *              decides it needs no tools.
 *   studio     ReAct over 5 content tools.
 *   workspace  ReAct over 16 Google tools. Separate from studio because its
 *              tools carry a human-approval gate and a very different prompt.
 *   vision     a file decides it, from the MIME type. Not a judgement.
 *   docqa      same.
 */

/** Node name -> the function that runs it. Adding a node starts here. */
const AGENT_NODES = {
  chat: chatAgent,
  studio: studioAgent,
  workspace: workspaceAgent,
  vision: visionAgent,
  docqa: docqaAgent,
} as const;

const builder = new StateGraph(GraphState)
  .addNode("router", routerNode)
  .addNode("chat", AGENT_NODES.chat)
  .addNode("studio", AGENT_NODES.studio)
  .addNode("workspace", AGENT_NODES.workspace)
  .addNode("vision", AGENT_NODES.vision)
  .addNode("docqa", AGENT_NODES.docqa);

builder.addEdge(START, "router");

/**
 * The router has already normalised `state.agent` to a real node name, so this
 * is a lookup rather than a second decision. The third argument is the map of
 * possible destinations, which LangGraph validates at compile time — a typo in
 * a name fails at boot rather than mid-conversation.
 */
builder.addConditionalEdges(
  "router",
  (state: GraphStateType) =>
    state.agent in AGENT_NODES ? (state.agent as AgentName) : "chat",
  {
    chat: "chat",
    studio: "studio",
    workspace: "workspace",
    vision: "vision",
    docqa: "docqa",
  },
);

builder.addEdge("chat", END);
builder.addEdge("studio", END);
builder.addEdge("workspace", END);
builder.addEdge("vision", END);
builder.addEdge("docqa", END);

/**
 * Compiled once at import time. Compilation validates the node and edge wiring,
 * so a typo in a destination name fails at boot rather than mid-conversation.
 */
export const graph = builder.compile();

/**
 * The agent picker in the UI.
 *
 * It no longer lists pdf / ppt / image / search separately: those are things
 * the studio makes, not modes a user picks. Asking for a deck is how you get a
 * deck.
 */
export const AGENT_CATALOG: Array<{
  id: AgentName | "auto";
  label: string;
  hint: string;
}> = [
  { id: "auto", label: "Auto", hint: "Let the router decide" },
  { id: "chat", label: "Chat", hint: "General questions and explanations" },
  {
    id: "studio",
    label: "Studio",
    hint: "Research, documents, decks, images and code",
  },
  {
    id: "workspace",
    label: "Calendar & Mail",
    hint: "Your meetings and inbox",
  },
];
