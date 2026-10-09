import { invokeModel } from "./gateway.js";
import type { AgentName, GraphStateType } from "./state.js";

/**
 * The router: the first node in the graph, and the only one that decides which
 * node runs.
 *
 * Three stages, cheapest first:
 *  1. An uploaded file settles it. Only vision and docqa can read a file, and
 *     which one depends on the MIME type, not on anything a model thinks.
 *  2. The user picked a mode in the UI. Respect it; no model call needed.
 *  3. Otherwise, ask a small model to classify.
 *
 * Stage 3 is the only one that costs a token, which is why it is last.
 *
 * ── Why this is short now ───────────────────────────────────────────────────
 *
 * It used to choose between seven agents, and later returned an ordered plan
 * with four correction rules to keep that plan executable. Both were doing work
 * that belonged inside a ReAct loop: once `search`, `pdf`, `ppt`, `image` and
 * `coding` became tools of the studio agent, there were only three things left
 * to choose between, and no sequencing to decide.
 *
 * The question is now genuinely simple: does this need the user's own Google
 * data, does it need a tool at all, or is it a plain question?
 */

/** The three the classifier may choose. vision/docqa are file-driven. */
const LLM_ROUTABLE: AgentName[] = ["chat", "studio", "workspace"];

const ROUTER_PROMPT = `You route a message to one of three handlers.

chat      - answerable from general knowledge, with no tool and nothing current.
            Explanations, definitions, advice, opinions, greetings, maths.

studio    - needs a tool to research or to MAKE something:
            anything current ("latest", "today", news, prices, releases),
            a document or report, a slide deck or presentation,
            an image or logo, or writing / reviewing code.

workspace - about THIS user's own calendar or email:
            their meetings, scheduling, rescheduling, cancelling, free time,
            availability, their inbox, reading / searching / sending /
            replying to mail, reminders.

Examples:
"what is a closure in js" -> chat
"explain the difference between TCP and UDP" -> chat
"should I use postgres or mongo" -> chat
"who won yesterday's match" -> studio
"what's the latest node version" -> studio
"make a pdf about climate change" -> studio
"research the latest on RAG and make a deck" -> studio
"create slides on AI in healthcare" -> studio
"draw a cat astronaut" -> studio
"build me a portfolio site" -> studio
"review this function for bugs" -> studio
"what's on my calendar today" -> workspace
"schedule a 30 min sync with sam tomorrow" -> workspace
"any unread mail from my manager?" -> workspace
"reply to that email and say yes" -> workspace
"am I free at 4pm?" -> workspace

Reply with one word, lowercase: chat, studio or workspace.`;

export async function routerNode(state: GraphStateType) {
  // 1. The attachment decides.
  if (state.file?.mimetype?.startsWith("image/")) {
    return { agent: "vision" as AgentName };
  }

  if (state.file?.mimetype === "application/pdf") {
    return { agent: "docqa" as AgentName };
  }

  // 2. The user already chose in the UI.
  if (
    state.agent &&
    state.agent !== "auto" &&
    LLM_ROUTABLE.includes(state.agent)
  ) {
    return { agent: state.agent };
  }

  // 3. Ask the model.
  try {
    state.onProgress?.("Routing");

    const result = await invokeModel(
      [
        ["system", ROUTER_PROMPT],
        ["human", state.prompt],
      ] as never,
      { role: "router", meter: state.meter },
    );

    return { agent: pickAgent(String(result.content)) };
  } catch (error) {
    // A broken router must never break the request: chat answers anything.
    console.warn("[router] falling back to chat:", (error as Error).message);
    return { agent: "chat" as AgentName };
  }
}

/**
 * Take the first valid handler name out of the reply.
 *
 * Models answer "Studio." and "handler: workspace" often enough that a bare
 * comparison is unsafe, so every word is matched against the allowlist and
 * anything unrecognised falls back to chat.
 *
 * Exported for the eval suite.
 */
export function pickAgent(reply: string): AgentName {
  const found = reply
    .toLowerCase()
    .match(/[a-z_]+/g)
    ?.find((word) => LLM_ROUTABLE.includes(word as AgentName));

  return (found as AgentName) ?? "chat";
}
