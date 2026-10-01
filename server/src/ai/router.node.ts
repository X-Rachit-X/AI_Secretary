import { invokeModel } from "./gateway.js";
import type { AgentName, GraphStateType } from "./state.js";

/**
 * The router: the first node in the graph, and the only one that decides.
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

const ROUTER_PROMPT = `You are the intent router of a multi-agent assistant.
Pick exactly ONE agent for the user message.

chat      - general conversation, explanations, advice, anything answerable from general knowledge
search    - needs fresh or real-time information: news, prices, scores, "latest", "today", recent releases
coding    - write, debug, review, explain or refactor code; build a website or app
pdf       - the user wants a PDF document generated (report, notes, guide, resume)
ppt       - the user wants a presentation, slides or a PowerPoint generated
image     - the user wants an image, logo, illustration or artwork generated
workspace - anything about THIS user's own calendar or email: their meetings,
            scheduling, rescheduling, cancelling, free time, availability,
            their inbox, reading/searching/sending/replying to mail, reminders

Examples:
"what is a closure in js" -> chat
"who won yesterday's match" -> search
"build me a portfolio site" -> coding
"make a pdf about climate change" -> pdf
"create slides on AI in healthcare" -> ppt
"draw a cat astronaut" -> image
"what's on my calendar today" -> workspace
"schedule a 30 min sync with sam tomorrow" -> workspace
"any unread mail from my manager?" -> workspace
"reply to that email and say yes" -> workspace
"am I free at 4pm?" -> workspace

Reply with the agent name only. One word, lowercase.`;

export async function routerNode(state: GraphStateType) {
  // 1. The attachment decides.
  if (state.file?.mimetype?.startsWith("image/")) {
    return { agent: "vision" as AgentName };
  }

  if (state.file?.mimetype === "application/pdf") {
    return { agent: "docqa" as AgentName };
  }

  // 2. The user already chose.
  if (
    state.agent &&
    state.agent !== "auto" &&
    LLM_ROUTABLE.includes(state.agent)
  ) {
    return { agent: state.agent };
  }

  // 3. Ask the model.
  try {
    state.onProgress?.("Choosing the right agent");

    const result = await invokeModel(
      [
        ["system", ROUTER_PROMPT],
        ["human", state.prompt],
      ] as never,
      { role: "router", meter: state.meter },
    );

    // Models answer "Search." or "agent: coding" often enough that parsing a
    // bare word is not safe. Take the first word that is a valid agent name.
    const agent = String(result.content)
      .toLowerCase()
      .match(/[a-z_]+/g)
      ?.find((word) => LLM_ROUTABLE.includes(word as AgentName)) as
      | AgentName
      | undefined;

    return { agent: agent ?? ("chat" as AgentName) };
  } catch (error) {
    // A broken router must never break the request: chat answers everything.
    console.warn("[router] falling back to chat:", (error as Error).message);
    return { agent: "chat" as AgentName };
  }
}
