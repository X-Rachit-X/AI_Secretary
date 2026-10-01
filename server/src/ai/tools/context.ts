import {
  looksLikeEmbeddedInstruction,
  wrapUntrusted,
} from "../../guardrails/index.js";

/**
 * What every tool in this folder shares.
 *
 * Tools are built fresh for each run rather than imported as module-level
 * constants. That is what lets them close over *this* turn's identity — whose
 * data, which conversation, which write budget — so a model can never name a
 * user, and a per-turn limit can never leak into the next turn.
 *
 * `counters` is the run's scratchpad: how many tools were called, and which
 * guardrails fired. The workspace agent returns it into graph state, and the
 * route writes it to the Trace row.
 */

export type ToolContext = {
  userId: string;
  conversationId: string;
  turnId: string;
};

export type ToolCounters = {
  calls: number;
  flags: string[];
};

export function newCounters(): ToolCounters {
  return { calls: 0, flags: [] };
}

export function flag(counters: ToolCounters, label: string) {
  if (!counters.flags.includes(label)) counters.flags.push(label);
}

/**
 * Wrap every tool handler so counting and error handling happen once.
 *
 * Returning the error as a string rather than throwing is deliberate: a thrown
 * error aborts the whole ReAct loop, while a message lets the model recover —
 * try a different search, or tell the user what went wrong. The agent is more
 * useful when a single failed tool call is survivable.
 */
export function tracked<Args>(
  counters: ToolCounters,
  name: string,
  handler: (args: Args) => Promise<unknown>,
) {
  return async (args: Args): Promise<string> => {
    counters.calls += 1;

    try {
      return JSON.stringify(await handler(args));
    } catch (error) {
      flag(counters, `tool.error.${name}`);

      return JSON.stringify({
        error: error instanceof Error ? error.message : "Tool failed",
        guidance:
          "Tell the user what failed in one line. Do not retry the same call.",
      });
    }
  };
}

/**
 * Return third-party content as data the model must not obey.
 *
 * Used by every tool that surfaces something written by someone other than the
 * user: email bodies, subjects, sender names, event titles and descriptions.
 * See guardrails/untrusted.ts for why this matters more than it looks.
 */
export function untrusted(
  counters: ToolCounters,
  source: string,
  payload: unknown,
): string {
  const serialised = JSON.stringify(payload, null, 2);

  if (looksLikeEmbeddedInstruction(serialised)) {
    // Does not block anything — it labels the trace, so a message carrying an
    // embedded instruction is visible on the Insights page instead of silent.
    flag(counters, "guardrail.untrusted_instruction_seen");
  }

  return wrapUntrusted(source, serialised);
}
