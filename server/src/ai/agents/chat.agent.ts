import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { invokeModel } from "../gateway.js";
import { runBilled } from "../../services/credits.service.js";
import type { GraphStateType } from "../state.js";

/**
 * General conversation: the cheap path.
 *
 * One model call, no tools. The router sends anything answerable from general
 * knowledge here precisely so a plain question does not pay for a ReAct loop
 * that would only decide it needs no tools.
 *
 * It used to also write the grounded answer after a web search, which is why it
 * once read `state.searchResults`. The studio agent owns that now: it searches
 * and answers inside one loop, so it can see an empty result and say so.
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

async function answer(state: GraphStateType) {
  const messages = [
    new SystemMessage(BASE_PROMPT),
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

  return { response: String(result.content) };
}

export async function chatAgent(state: GraphStateType) {
  state.onProgress?.("Writing a reply");

  return runBilled(state.userId, "chat", () => answer(state));
}
