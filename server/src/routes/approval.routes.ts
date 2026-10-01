import { Router } from "express";
import { prisma } from "../db.js";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import { cancelMeeting } from "../google/calendar.js";
import { replyToMail, sendMail } from "../google/gmail.js";
import { saveMessage } from "../services/conversation.service.js";
import { createNotification } from "../services/notification.service.js";
import { claimAction, rejectAction } from "../guardrails/index.js";
import { AppError, statusOf, toErrorBody } from "../lib/errors.js";

/**
 * Human-in-the-loop: where a proposed action actually happens.
 *
 * This is the other half of guardrails/tool.guard.ts, and the most important
 * property of the whole guardrail design lives here:
 *
 *   **No model is involved in this request.**
 *
 * The agent proposed the action and wrote a description of it. The user read
 * that description and pressed Approve. This route loads the stored arguments
 * and calls the Google function directly. There is no second model call between
 * the user's decision and the effect, so nothing — not a crafted email, not a
 * confused ReAct loop — can change what runs after they agreed to it.
 *
 * `claimAction` flips the status with a conditional update, so a double-click
 * cannot send the same email twice.
 */

export const approvalRoutes = Router();

approvalRoutes.use(requireAuth);

/** The executor table. Adding a gated tool means adding one entry here. */
const EXECUTORS: Record<
  string,
  (userId: string, args: Record<string, unknown>) => Promise<unknown>
> = {
  send_mail: (userId, args) =>
    sendMail({
      userId,
      to: args.to as string[],
      subject: args.subject as string,
      body: args.body as string,
      cc: args.cc as string[] | undefined,
    }),

  reply_to_mail: (userId, args) =>
    replyToMail({
      userId,
      messageId: args.messageId as string,
      body: args.body as string,
    }),

  cancel_meeting: (userId, args) =>
    cancelMeeting({ userId, eventId: args.eventId as string }),
};

approvalRoutes.get("/", async (req, res) => {
  try {
    const rows = await prisma.pendingAction.findMany({
      where: { userId: currentUser(req).id, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    res.json({
      approvals: rows.map((row) => ({
        id: row.id,
        tool: row.tool,
        summary: row.summary,
        args: JSON.parse(row.args) as Record<string, unknown>,
        conversationId: row.conversationId,
        expiresAt: row.expiresAt.toISOString(),
      })),
    });
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});

approvalRoutes.post("/:id/approve", async (req, res) => {
  const user = currentUser(req);

  try {
    const claim = await claimAction(req.params.id, user.id);

    if (!claim.ok) {
      const messages: Record<string, string> = {
        not_found: "That action no longer exists.",
        already_resolved: "That action was already approved or rejected.",
        expired: "That action expired. Ask again and I'll propose a fresh one.",
      };

      throw new AppError(
        409,
        "Cannot approve",
        messages[claim.reason] ?? "That action cannot be approved.",
      );
    }

    const executor = EXECUTORS[claim.action.tool];

    if (!executor) {
      throw new AppError(
        500,
        "Unknown action",
        `No executor is registered for ${claim.action.tool}.`,
      );
    }

    const result = await executor(user.id, claim.action.args);

    // Record the outcome in the transcript, so the thread reads as a complete
    // story rather than jumping from "shall I?" to silence.
    const message = await saveMessage({
      conversationId: claim.action.conversationId,
      userId: user.id,
      role: "assistant",
      content: `Done — ${claim.action.summary.toLowerCase()}.`,
      agent: "workspace",
    });

    await createNotification({
      userId: user.id,
      kind: "agent",
      title: "Action completed",
      body: claim.action.summary,
    });

    res.json({ success: true, result, message });
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});

approvalRoutes.post("/:id/reject", async (req, res) => {
  try {
    await rejectAction(req.params.id, currentUser(req).id);
    res.json({ success: true });
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});
