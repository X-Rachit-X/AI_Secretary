import { prisma } from "../db.js";
import { POLICY } from "./policy.js";

/**
 * Layer 3: what the agent is allowed to DO.
 *
 * This is the only guardrail that is not advisory. Layers 1, 2 and 4 are text
 * analysis, and text analysis can be talked around. This layer is a hard gate
 * in front of the three irreversible actions: sending mail, replying, and
 * cancelling a meeting.
 *
 * The design is "propose, then approve":
 *
 *   1. The model calls send_mail.
 *   2. The guard does not send anything. It writes a PendingAction row and
 *      returns a string telling the model an approval is required.
 *   3. The model, seeing that, tells the user what it intends to do.
 *   4. The UI renders an Approve / Reject card from the PendingAction.
 *   5. On approve, the server executes the tool DIRECTLY — no model in the
 *      loop, with the exact arguments the user saw.
 *
 * Step 5 is the point. The thing that runs is the thing the user read. There
 * is no second model call between approval and execution that could have been
 * influenced by anything.
 */

const APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * Per-turn write budget.
 *
 * Keyed by a token the route mints for each graph run, so counts cannot leak
 * between turns or between users. Entries are deleted when the run ends.
 */
const writeBudget = new Map<string, number>();

export function openTurn(turnId: string) {
  writeBudget.set(turnId, 0);
}

export function closeTurn(turnId: string) {
  writeBudget.delete(turnId);
}

function spendWrite(turnId: string): boolean {
  const used = writeBudget.get(turnId) ?? 0;

  if (used >= POLICY.tool.maxWritesPerTurn) return false;

  writeBudget.set(turnId, used + 1);
  return true;
}

export function requiresApproval(toolName: string) {
  return POLICY.tool.requiresApproval.includes(toolName);
}

/** Entry denies an exact address, or a whole domain when it starts with "@". */
function recipientDenied(email: string) {
  const address = email.toLowerCase().trim();

  return POLICY.tool.recipientDenyList.some((entry) =>
    entry.startsWith("@")
      ? address.endsWith(entry.toLowerCase())
      : address === entry.toLowerCase(),
  );
}

/** Checks that apply before anything is even proposed to the user. */
function validate(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === "send_mail") {
    const to = Array.isArray(args.to) ? (args.to as string[]) : [];
    const cc = Array.isArray(args.cc) ? (args.cc as string[]) : [];
    const everyone = [...to, ...cc];

    if (everyone.length > POLICY.tool.maxRecipientsPerMessage) {
      return `That message has ${everyone.length} recipients and the limit is ${POLICY.tool.maxRecipientsPerMessage}.`;
    }

    const denied = everyone.find(recipientDenied);
    if (denied) return `${denied} is on the blocked recipient list.`;
  }

  return null;
}

/** The one line the user reads before approving. Must be specific. */
function summarise(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "send_mail": {
      const to = Array.isArray(args.to) ? (args.to as string[]).join(", ") : "?";
      return `Send "${args.subject ?? "(no subject)"}" to ${to}`;
    }
    case "reply_to_mail":
      return `Reply in thread ${String(args.messageId ?? "?").slice(0, 12)}…`;
    case "cancel_meeting":
      return `Cancel meeting ${String(args.eventId ?? "?").slice(0, 16)}… and notify attendees`;
    default:
      return `Run ${toolName}`;
  }
}

export type GuardedToolContext = {
  userId: string;
  conversationId: string;
  turnId: string;
};

/**
 * Called by a destructive tool instead of doing the work.
 *
 * Returns the string the tool hands back to the model. Three outcomes:
 *   - rejected outright (validation failed)
 *   - budget exhausted
 *   - approval pending, with the id and summary the model should describe
 */
export async function proposeAction(
  context: GuardedToolContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const problem = validate(toolName, args);

  if (problem) {
    return JSON.stringify({
      status: "rejected",
      reason: problem,
      guidance: "Tell the user why this was not allowed. Do not retry.",
    });
  }

  if (!spendWrite(context.turnId)) {
    return JSON.stringify({
      status: "rejected",
      reason: `Limit of ${POLICY.tool.maxWritesPerTurn} write actions per turn reached.`,
      guidance:
        "Tell the user you have hit the per-message action limit and ask them to continue in a new message.",
    });
  }

  const summary = summarise(toolName, args);

  const action = await prisma.pendingAction.create({
    data: {
      userId: context.userId,
      conversationId: context.conversationId,
      tool: toolName,
      args: JSON.stringify(args),
      summary,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    },
  });

  return JSON.stringify({
    status: "approval_required",
    actionId: action.id,
    summary,
    guidance: [
      "This action has NOT happened yet and will not happen until the user",
      "approves it in the interface. Do not call this tool again.",
      "Write a short reply that states exactly what you are about to do",
      "(recipients, subject, and the full body if it is an email) so the user",
      "can check it before approving.",
    ].join(" "),
  });
}

/** Everything proposed during one run, for the completed SSE event. */
export async function pendingForTurn(
  userId: string,
  conversationId: string,
  since: Date,
) {
  const rows = await prisma.pendingAction.findMany({
    where: {
      userId,
      conversationId,
      status: "pending",
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => ({
    id: row.id,
    tool: row.tool,
    summary: row.summary,
    args: JSON.parse(row.args) as Record<string, unknown>,
    expiresAt: row.expiresAt.toISOString(),
  }));
}

/**
 * Claim an action for execution.
 *
 * The status flip is a conditional update, so a double-click cannot run the
 * same action twice: the second call finds nothing still "pending".
 */
export async function claimAction(actionId: string, userId: string) {
  const action = await prisma.pendingAction.findFirst({
    where: { id: actionId, userId },
  });

  if (!action) return { ok: false as const, reason: "not_found" };
  if (action.status !== "pending")
    return { ok: false as const, reason: "already_resolved" };
  if (action.expiresAt < new Date()) {
    await prisma.pendingAction.update({
      where: { id: actionId },
      data: { status: "expired" },
    });
    return { ok: false as const, reason: "expired" };
  }

  const claimed = await prisma.pendingAction.updateMany({
    where: { id: actionId, status: "pending" },
    data: { status: "approved" },
  });

  if (claimed.count === 0)
    return { ok: false as const, reason: "already_resolved" };

  return {
    ok: true as const,
    action: {
      id: action.id,
      tool: action.tool,
      conversationId: action.conversationId,
      summary: action.summary,
      args: JSON.parse(action.args) as Record<string, unknown>,
    },
  };
}

export async function rejectAction(actionId: string, userId: string) {
  await prisma.pendingAction.updateMany({
    where: { id: actionId, userId, status: "pending" },
    data: { status: "rejected" },
  });

  return { ok: true };
}
