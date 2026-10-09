import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { invokeModel } from "../gateway.js";
import { runBilled } from "../../services/credits.service.js";
import type { GraphStateType } from "../state.js";

/**
 * General conversation, and the place web search results get turned into prose.
 *
 * Two entry paths:
 *  - direct   : the router sent a plain question here. Charge for "chat".
 *  - grounded : the search node ran first and put results in state. Do NOT
 *               charge again; the search node already billed this turn.
 *
 * That split is the reason `searchResults` is `string | undefined` rather than
 * just a string: undefined means no search happened, "" means search ran and
 * came back empty, and the answer is worded differently in each case.
 */

const BASE_PROMPT = `You are AI Secretary, a sharp and direct AI assistant.

Rules:
- Short questions and greetings get short, plain answers. No headings.
- Technical, educational or multi-part answers use clean Markdown.

Formatting when you do use Markdown:
- ## for sections. Blank line after every heading.
- Bullets for lists, numbers for ordered steps.
- Fenced code blocks with a language tag.
- Short paragraphs. Never a wall of text.
- Never put a heading and its content on the same line.`;

function groundingPrompt(results: string | undefined) {
  if (results === undefined) return "";

  if (!results.trim()) {
    return `

A web search was attempted for this question but returned nothing. Answer from
your own knowledge and say in one short line that it may not be current.`;
  }

  return `

Web search results for the user's question:

${results}

- These are more recent than your training data. Prefer them.
- Cite inline as [1], [2], matching the numbers above.
- End with a "Sources" list of the URLs you actually used.
- Never mention that a search was performed or name any internal tool.`;
}

async function answer(state: GraphStateType) {
  const messages = [
    new SystemMessage(BASE_PROMPT + groundingPrompt(state.searchResults)),
    ...state.history.map((turn) =>
      turn.role === "user"
        ? new HumanMessage(turn.content)
        : new AIMessage(turn.content),
    ),
    new HumanMessage(state.prompt),
  ];

  const result = await invokeModel(messages, {
    role: "chat",
    meter: state.meter,
  });

  return {
    response: String(result.content),
    // Carried through so image results from the search node survive to the UI.
    images: state.images ?? [],
  };
}

export async function chatAgent(state: GraphStateType) {
  state.onProgress?.("Writing a reply");

  // Arrived via search: that node already charged for this turn.
  if (state.searchResults !== undefined) {
    return answer(state);
  }

  return runBilled(state.userId, "chat", () => answer(state));
}
