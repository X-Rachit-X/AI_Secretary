/**
 * Guardrails, in four layers.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ 1. INPUT      input.guard.ts    redact secrets, block a few   │
 *   │                                  intents, flag injection      │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 2. TRUST      untrusted.ts      wrap third-party content so   │
 *   │                                  the model reads it as data   │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 3. TOOL       tool.guard.ts     HUMAN APPROVAL before any     │
 *   │                                  irreversible action  ← hard  │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ 4. OUTPUT     output.guard.ts   catch prompt leaks, secrets   │
 *   │                                  and unsafe link schemes      │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Layers 1, 2 and 4 are text analysis and can be talked around by a
 * sufficiently clever prompt. Layer 3 cannot: it is a database row and a
 * button. That asymmetry is the whole design — the soft layers reduce how
 * often something odd reaches the model, and the hard layer makes it not
 * matter very much when one does.
 *
 * Every verdict contributes `flags` to the run's Trace row, so the Insights
 * page shows what fired and how often. A guardrail nobody can observe is a
 * guardrail nobody will maintain.
 */

export { POLICY, type GuardVerdict } from "./policy.js";
export { guardInput, injectionWarning } from "./input.guard.js";
export { guardOutput } from "./output.guard.js";
export {
  wrapUntrusted,
  looksLikeEmbeddedInstruction,
  SYSTEM_RULE,
} from "./untrusted.js";
export {
  proposeAction,
  requiresApproval,
  pendingForTurn,
  claimAction,
  rejectAction,
  openTurn,
  closeTurn,
  type GuardedToolContext,
} from "./tool.guard.js";
