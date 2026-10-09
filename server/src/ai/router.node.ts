import { invokeModel } from "./gateway.js";
import {
  MAX_PLAN_STEPS,
  type AgentName,
  type GraphStateType,
} from "./state.js";

/**
 * The router: the first node in the graph, and the only one that decides.
 *
 * It returns a PLAN — an ordered list of agents — not a single agent. Most
 * turns are one agent, but some genuinely need two, and expressing that as a
 * list is what removed the hardcoded `search -> chat` edge the graph used to
 * carry. See the header comment in graph.ts.
 *
 * Three stages, cheapest first:
 *  1. An uploaded file settles it. Only vision and docqa can read a file, and
 *     which one depends on the MIME type, not on anything the model thinks.
 *  2. The user picked an agent in the UI. Respect it; no model call needed.
 *  3. Otherwise, ask a small model to classify the intent.
 *
 * Stage 3 is the only one that costs a token, which is why it is last.
 */

/**
 * Agents the classifier may choose.
 *
 * `vision` and `docqa` are missing on purpose: they need a file, and letting
 * the model pick them from text alone would route to an agent with nothing to
 * read.
 */
const LLM_ROUTABLE: AgentName[] = [
  "chat",
  "search",
  "coding",
  "pdf",
  "ppt",
  "image",
  "workspace",
];

/**
 * Which agents may legally follow `search`.
 *
 * Search only gathers; something has to write the answer. Restricting the
 * second step to the agents that can consume research keeps the model from
 * inventing nonsense chains like `search -> image`.
 */
const SEARCH_CONSUMERS: AgentName[] = ["chat", "pdf", "ppt", "coding"];

const ROUTER_PROMPT = `You are the intent router of a multi-agent assistant.

Reply with ONE agent, or TWO separated by " -> " when the request genuinely
needs research before producing something.

Agents:
chat      - general conversation, explanations, advice, anything answerable from general knowledge
search    - gathers fresh or real-time information: news, prices, scores, "latest", "today", recent releases.
            search NEVER answers on its own; it must be followed by chat, pdf, ppt or coding
coding    - write, debug, review, explain or refactor code; build a website or app
pdf       - the user wants a PDF document generated (report, notes, guide, resume)
ppt       - the user wants a presentation, slides or a PowerPoint generated
image     - the user wants an image, logo, illustration or artwork generated
workspace - anything about THIS user's own calendar or email: their meetings,
            scheduling, rescheduling, cancelling, free time, availability,
            their inbox, reading/searching/sending/replying to mail, reminders

Use TWO agents only when the request needs CURRENT information it does not
supply. If the user gives you the topic and no freshness is implied, use one.

Examples:
"what is a closure in js" -> chat
"who won yesterday's match" -> search -> chat
"what's the latest node version" -> search -> chat
"build me a portfolio site" -> coding
"make a pdf about climate change" -> pdf
"research the latest on RAG and make a deck" -> search -> ppt
"write a report on 2026 EV sales using current data" -> search -> pdf
"create slides on AI in healthcare" -> ppt
"draw a cat astronaut" -> image
"what's on my calendar today" -> workspace
"any unread mail from my manager?" -> workspace
"am I free at 4pm?" -> workspace

Reply with the agent name or names only. Lowercase. No explanation.`;

/**
 * Turn the model's reply into a validated plan.
 *
 * Models answer "Search." and "agent: coding" often enough that a bare split
 * is unsafe, so every word is matched against the allowlist and anything else
 * is dropped. Three rules then make the plan safe to execute:
 *
 *   - de-duplicate, so "chat -> chat" cannot loop
 *   - a trailing `search` gets `chat` appended, because search cannot answer
 *   - a `search` followed by something that cannot read research is corrected
 */
function parsePlan(reply: string): AgentName[] {
  const words = String(reply).toLowerCase().match(/[a-z_]+/g) ?? [];

  const picked: AgentName[] = [];

  for (const word of words) {
    const agent = word as AgentName;
    if (LLM_ROUTABLE.includes(agent) && !picked.includes(agent)) {
      picked.push(agent);
    }
  }

  if (picked.length === 0) return ["chat"];

  const plan = picked.slice(0, MAX_PLAN_STEPS);

  // search must be followed by an agent that can write from research.
  const searchIndex = plan.indexOf("search");

  if (searchIndex !== -1) {
    const follower = plan[searchIndex + 1];

    if (!follower) {
      plan.push("chat");
    } else if (!SEARCH_CONSUMERS.includes(follower)) {
      plan.splice(searchIndex + 1, plan.length, "chat");
    }
  }

  return plan.slice(0, MAX_PLAN_STEPS);
}

/** A plan plus the agent credited on the final message. */
function asPlan(plan: AgentName[]) {
  return { plan, agent: plan[plan.length - 1] };
}

export async function routerNode(state: GraphStateType) {
  // 1. The attachment decides. No model call, no ambiguity.
  if (state.file?.mimetype?.startsWith("image/")) {
    return asPlan(["vision"]);
  }

  if (state.file?.mimetype === "application/pdf") {
    return asPlan(["docqa"]);
  }

  // 2. The user already chose in the UI.
  if (
    state.agent &&
    state.agent !== "auto" &&
    LLM_ROUTABLE.includes(state.agent)
  ) {
    // Picking "search" by hand still needs a writer after it.
    return asPlan(
      state.agent === "search" ? ["search", "chat"] : [state.agent],
    );
  }

  // 3. Ask the model.
  try {
    state.onProgress?.("Planning");

    const result = await invokeModel(
      [
        ["system", ROUTER_PROMPT],
        ["human", state.prompt],
      ] as never,
      { role: "router", meter: state.meter },
    );

    const plan = parsePlan(String(result.content));

    if (plan.length > 1) {
      state.onProgress?.(`Running ${plan.join(" then ")}`);
    }

    return asPlan(plan);
  } catch (error) {
    // A broken router must never break the request: chat answers everything.
    console.warn("[router] falling back to chat:", (error as Error).message);
    return asPlan(["chat"]);
  }
}

/** Exported for the eval suite, which asserts the plan rules directly. */
export { parsePlan, SEARCH_CONSUMERS };
