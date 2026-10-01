import { createCalendarTools } from "./calendar.tools.js";
import { createMailTools } from "./mail.tools.js";
import { createNotifyTools } from "./notify.tools.js";
import { newCounters, type ToolContext } from "./context.js";

/**
 * The full toolbelt handed to the workspace agent.
 *
 * Calendar, mail and notifications are bound together on purpose. Real
 * requests cross all three ("find the thread about the launch, then book 30
 * minutes with everyone on it, and remind me an hour before"), and an agent
 * that can only see one of them has to hand work back to the user.
 *
 * Built per run rather than once at import: the tools close over this turn's
 * user, conversation and write budget, and share one counters object so the
 * agent can report tool usage and guardrail flags back into graph state.
 */
export function createWorkspaceTools(context: ToolContext) {
  const counters = newCounters();

  return {
    tools: [
      ...createCalendarTools(context, counters),
      ...createMailTools(context, counters),
      ...createNotifyTools(context, counters),
    ],
    counters,
  };
}

export { createCalendarTools, createMailTools, createNotifyTools };
export { loadPreferences } from "./notify.tools.js";
export {
  newCounters,
  type ToolContext,
  type ToolCounters,
} from "./context.js";
