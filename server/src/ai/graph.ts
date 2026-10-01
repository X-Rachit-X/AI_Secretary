import { END, START, StateGraph } from "@langchain/langgraph";
import { GraphState, type AgentName, type GraphStateType } from "./state.js";
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
 *                       ┌──────────┐
 *            START ───▶ │  router  │
 *                       └────┬─────┘
 *                            │ conditional edge on state.agent
 *     ┌────────┬────────┬────┴───┬────────┬────────┬─────────┬───────────┐
 *     ▼        ▼        ▼        ▼        ▼        ▼         ▼           ▼
 *  search   coding    pdf      ppt     image    vision     docqa    workspace
 *     │        │       │        │        │        │          │           │
 *     ▼        └───────┴────────┴────────┴────────┴──────────┴───────────┘
 *   chat ──────────────────────────────────────────────────────────────▶ END
 *
 * One special edge: search does NOT end. It fetches results into state and
 * hands off to chat, which writes the cited answer. Every other agent produces
 * its own final response and goes straight to END.
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

const builder = new StateGraph(GraphState)
  .addNode("router", routerNode)
  .addNode("chat", AGENT_NODES.chat)
  .addNode("search", AGENT_NODES.search)
  .addNode("coding", AGENT_NODES.coding)
  .addNode("pdf", AGENT_NODES.pdf)
  .addNode("ppt", AGENT_NODES.ppt)
  .addNode("image", AGENT_NODES.image)
  .addNode("vision", AGENT_NODES.vision)
  .addNode("docqa", AGENT_NODES.docqa)
  .addNode("workspace", AGENT_NODES.workspace);

builder.addEdge(START, "router");

/**
 * The conditional edge. The router already normalised `state.agent` to a real
 * agent name, so this is a lookup, not a second decision. The third argument
 * is the map of possible destinations, which LangGraph uses to validate the
 * graph at compile time.
 */
builder.addConditionalEdges(
  "router",
  (state: GraphStateType) => {
    const agent = state.agent as AgentName;
    return agent in AGENT_NODES ? agent : "chat";
  },
  {
    chat: "chat",
    search: "search",
    coding: "coding",
    pdf: "pdf",
    ppt: "ppt",
    image: "image",
    vision: "vision",
    docqa: "docqa",
    workspace: "workspace",
  },
);

// Search is the one hand-off: fetch, then let chat write the answer.
builder.addEdge("search", "chat");

builder.addEdge("chat", END);
builder.addEdge("coding", END);
builder.addEdge("pdf", END);
builder.addEdge("ppt", END);
builder.addEdge("image", END);
builder.addEdge("vision", END);
builder.addEdge("docqa", END);
builder.addEdge("workspace", END);

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
  { id: "auto", label: "Auto", hint: "Let the router pick the right agent" },
  { id: "chat", label: "Chat", hint: "General questions and explanations" },
  { id: "workspace", label: "Calendar & Mail", hint: "Your meetings and inbox" },
  { id: "search", label: "Web search", hint: "Fresh information with citations" },
  { id: "coding", label: "Code", hint: "Build, review, debug" },
  { id: "pdf", label: "PDF", hint: "Generate a PDF document" },
  { id: "ppt", label: "Slides", hint: "Generate a PowerPoint deck" },
  { id: "image", label: "Image", hint: "Generate a picture" },
];
