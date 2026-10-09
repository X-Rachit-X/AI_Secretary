import { createReactAgent } from "@langchain/langgraph/prebuilt";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { getModel } from "../models.js";
import {
  createContentTools,
  newStudioOutputs,
} from "../tools/content.tools.js";
import { newCounters } from "../tools/context.js";
import { SYSTEM_RULE, injectionWarning } from "../../guardrails/index.js";
import type { Artifact } from "../../services/conversation.service.js";
import type { GraphStateType } from "../state.js";

/**
 * The studio: research and make things.
 *
 * A ReAct loop over five tools — web_search, make_deck, make_pdf, make_image,
 * write_code.
 *
 * ── Why this replaced five graph nodes ──────────────────────────────────────
 *
 * `search`, `pdf`, `ppt`, `image` and `coding` used to be separate nodes, and
 * the router picked one. That could not serve "research the latest on RAG and
 * make a deck", so a plan mechanism was added: the router returned an ordered
 * list and the graph walked it.
 *
 * That was a scheduler for things that never needed scheduling. Each of those
 * five did exactly "call a model once, parse, render, return" — no loop, no
 * choice. **An agent is something that decides; they decided nothing.** So the
 * graph was deciding on their behalf, in advance, from the prompt alone.
 *
 * As tools in a ReAct loop the deciding happens where it belongs — after each
 * result is visible. Concretely, what the plan could not do and this can:
 *
 *   - search comes back EMPTY, so the model says so instead of writing a deck
 *     from training data and implying it was researched
 *   - the first query is too narrow, so it searches again with a better one
 *   - the request turns out not to need research after all, so it skips it
 *   - "make a deck and an image for the cover" is two generate calls, which no
 *     two-step plan could express
 *
 * And it deleted more than it added: `plan`, `planStep`, `parsePlan` with its
 * four correction rules, `nextInPlan`, `withPlanAdvance` and five graph nodes
 * are all gone.
 *
 * ── What stayed a node, and why ─────────────────────────────────────────────
 *
 * `chat` is still a one-shot node: a plain question should not pay for a loop
 * that decides it needs no tools. `vision` and `docqa` are still nodes because
 * a file decides them from its MIME type, which is not a judgement.
 * `workspace` is its own loop because Google tools carry an approval gate and
 * a different system prompt.
 */

function buildSystemPrompt(suspicious: boolean) {
  return `You are AI Secretary Studio. You research topics and produce things:
documents, slide decks, images and code.

Current time: ${new Date().toISOString()}

How to work:
- If the answer depends on anything current — news, prices, releases, "latest",
  "today" — call web_search FIRST, then produce the thing from those results.
- If the request is about a stable topic the user supplied, generate directly.
  Do not search for the sake of searching.
- After web_search returns, READ IT before deciding. If it came back empty, say
  so plainly. Never produce a document that implies it was researched when it
  was not.
- One tool call per thing the user asked for. Do not regenerate something that
  already succeeded.

Answering:
- After a tool creates a file, give one line of confirmation and the download
  link as [Download <name>](url). Do not describe the generation process.
- For an image, show it with ![description](url) and stop.
- For code, say what was built in one line and point at the panel. Never paste
  the code into the chat.
- When you searched, cite inline as [1], [2] and end with a Sources list of the
  URLs you used.
- Never mention tool names, internal limits, or that you are an agent.
- Skip filler closings. Stop when the answer is done.
${SYSTEM_RULE}${suspicious ? `\n${injectionWarning()}` : ""}`;
}

export async function studioAgent(state: GraphStateType) {
  state.onProgress?.("Working out what to make");

  const counters = newCounters();
  const outputs = newStudioOutputs();

  const tools = createContentTools(
    { userId: state.userId, meter: state.meter, counters },
    outputs,
  );

  const agent = createReactAgent({ llm: getModel("workspace"), tools });

  const messages = [
    new SystemMessage(buildSystemPrompt(state.suspicious)),
    ...state.history.map((turn) =>
      turn.role === "user"
        ? new HumanMessage(turn.content)
        : new AIMessage(turn.content),
    ),
    new HumanMessage(state.prompt),
  ];

  /**
   * recursionLimit caps the loop. One step is one model call or one tool call,
   * so 18 allows roughly eight tool calls — comfortably above the per-turn
   * budgets in content.tools.ts, which are the real ceiling.
   */
  const result = await agent.invoke({ messages }, { recursionLimit: 18 });

  // The loop ends on an assistant message with no tool calls: the answer.
  const last = result.messages.at(-1);
  const response =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? "");

  return {
    response: response.trim() || "I could not produce that.",
    // Merge the side channel: things the UI renders specially.
    images: outputs.images,
    artifacts: outputs.artifacts as unknown as Artifact[],
    flags: counters.flags,
    toolCalls: counters.calls,
  };
}
