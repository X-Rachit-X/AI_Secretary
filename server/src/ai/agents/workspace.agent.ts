import { createReactAgent } from "@langchain/langgraph/prebuilt";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { getModel } from "../models.js";
import { createWorkspaceTools, loadPreferences } from "../tools/index.js";
import { runBilled } from "../../services/credits.service.js";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { SYSTEM_RULE, injectionWarning } from "../../guardrails/index.js";
import { POLICY } from "../../guardrails/policy.js";
import type { GraphStateType } from "../state.js";

/**
 * The calendar + mail agent. This is the heart of "chat with your calendar",
 * and the only agent with a real blast radius, so it carries the guardrails.
 *
 * Unlike the other agents, which call a model once and format the result, this
 * one is a ReAct loop: the model picks a tool, sees the result, and decides
 * what to do next, until it has enough to answer. That loop is what makes
 * multi-step requests work, for example:
 *
 *   "move my 3pm to tomorrow and tell the attendees why"
 *     -> list_meetings        (find the event id)
 *     -> reschedule_meeting   (move it)
 *     -> send_mail            (PROPOSED — waits for the user to approve)
 *     -> final answer
 *
 * `createReactAgent` from LangGraph builds that loop. We supply the model, the
 * tools and the system prompt; it handles the tool-call plumbing.
 *
 * Three guardrails meet here:
 *   - SYSTEM_RULE tells the model that tool results are data, not orders
 *   - the tools wrap third-party content in untrusted delimiters
 *   - destructive tools propose instead of acting (guardrails/tool.guard.ts)
 */

/**
 * Preferences are injected as plain text rather than looked up by a tool.
 * They are small, they are needed almost every run, and a tool call to fetch
 * them would be a wasted round trip on every single request.
 */
function buildSystemPrompt(
  preferences: Record<string, string>,
  suspicious: boolean,
) {
  const prefLines = Object.entries(preferences)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");

  const approvalList = POLICY.tool.requiresApproval.join(", ");

  return `You are AI Secretary Workspace, the user's calendar and email assistant.
You act on the user's REAL Google Calendar and Gmail through tools.

Current time: ${new Date().toISOString()}
${
  prefLines
    ? `\nWhat you already know about this user:\n${prefLines}\n`
    : "\nYou have no stored preferences for this user yet.\n"
}
Working with tools:
- Never guess at calendar or mail content. If you do not have it, call a tool.
- Reschedule and cancel need an event id. Get it from list_meetings first.
- Reply and read need a message id. Get it from search_mail first.
- For "am I free at X", use check_busy. For "find me time", use find_free_slot.
- Prefer one precise search_mail query over listing everything and filtering.

Actions that need the user's approval (${approvalList}):
- Calling one of these does NOT perform it. It creates a proposal the user must
  approve in the interface, and the tool tells you so.
- When you get status "approval_required", stop calling tools. Write a short
  message setting out exactly what will happen: recipients, subject, and the
  full body for an email; the meeting title and time for a cancellation. The
  user is about to approve based on what you write, so it must be complete.
- Never call the same proposing tool twice for one request.
- When you get status "rejected", explain why and do not retry.

Reading is free: list, search and read whenever it helps.
Creating or moving a meeting the user clearly asked for happens immediately and
needs no approval.

When the user states a preference ("I'm in IST", "make my default 45 min",
"always invite Sam"), call remember_preference. Do not ask them twice.
${SYSTEM_RULE}

Defaults when the user is vague:
- Meeting length: ${preferences.default_meeting_minutes ?? "30"} minutes.
- "Tomorrow" with no time: 10:00 in the user's timezone.
- Add a Google Meet link unless they say not to.

How to answer (match the question, do not use one template):
- "What's on / my agenda" -> short bullets, title and time. Nothing else.
- "What is this about" -> use the description, attendees and location. If the
  description is empty, say so in one line. Never invent an agenda.
- "Summarise" -> one or two sentences. Do not repeat a field list you just showed.
- After create / reschedule -> one line of confirmation, then the key fields.
- Links as [View meeting](url) or [Join Meet](url), never bare URLs.
- Skip filler closings. Stop when the answer is done.${
    suspicious ? `\n${injectionWarning()}` : ""
  }`;
}

export async function workspaceAgent(state: GraphStateType) {
  // Fail early and clearly: a tool error deep inside the ReAct loop surfaces
  // as something far less helpful than this.
  const account = await prisma.googleAccount.findUnique({
    where: { userId: state.userId },
    select: { id: true },
  });

  if (!account) throw AppError.notConnected("Google");

  return runBilled(state.userId, "workspace", async () => {
    state.onProgress?.("Reading your calendar and inbox");

    const preferences = await loadPreferences(state.userId);

    // The tools are built per run so they can close over this turn's identity:
    // whose data, which conversation, and which write budget.
    const { tools, counters } = createWorkspaceTools({
      userId: state.userId,
      conversationId: state.conversationId,
      turnId: state.turnId,
    });

    const agent = createReactAgent({
      llm: getModel("workspace"),
      tools,
    });

    const messages = [
      new SystemMessage(buildSystemPrompt(preferences, state.suspicious)),
      ...state.history.map((turn) =>
        turn.role === "user"
          ? new HumanMessage(turn.content)
          : new AIMessage(turn.content),
      ),
      new HumanMessage(state.prompt),
    ];

    // recursionLimit guards against a tool-call loop burning the user's
    // quota. One step is one model call or one tool call.
    const result = await agent.invoke({ messages }, { recursionLimit: 24 });

    // The ReAct loop ends on an assistant message with no tool calls; that is
    // the answer meant for the user.
    const last = result.messages.at(-1);
    const response =
      typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content ?? "");

    return {
      response:
        response.trim() ||
        "I could not complete that against your calendar or inbox.",
      flags: counters.flags,
      toolCalls: counters.calls,
    };
  });
}
