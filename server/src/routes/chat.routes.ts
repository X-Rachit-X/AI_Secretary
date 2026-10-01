import { Router } from "express";
import { z } from "zod";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import {
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  renameConversation,
} from "../services/conversation.service.js";
import { statusOf, toErrorBody } from "../lib/errors.js";

/**
 * Conversation CRUD: everything the chat sidebar needs.
 *
 * Deliberately separate from agent.routes.ts. These are small, fast, ordinary
 * JSON endpoints; that file is one long-lived streaming endpoint. Mixing them
 * makes both harder to read.
 */

export const chatRoutes = Router();

chatRoutes.use(requireAuth);

/** Keeps every handler's error path to one line. */
function handle(fn: (req: any, res: any) => Promise<unknown>) {
  return async (req: any, res: any) => {
    try {
      res.json(await fn(req, res));
    } catch (error) {
      res.status(statusOf(error)).json(toErrorBody(error));
    }
  };
}

chatRoutes.get(
  "/conversations",
  handle(async (req) => ({
    conversations: await listConversations(currentUser(req).id),
  })),
);

chatRoutes.post(
  "/conversations",
  handle(async (req) => {
    const title =
      typeof req.body?.title === "string" ? req.body.title : undefined;

    return {
      conversation: await createConversation(currentUser(req).id, title),
    };
  }),
);

chatRoutes.get(
  "/conversations/:id/messages",
  handle(async (req) => ({
    messages: await listMessages({
      conversationId: req.params.id,
      userId: currentUser(req).id,
    }),
  })),
);

const renameSchema = z.object({ title: z.string().min(1).max(120) });

chatRoutes.patch(
  "/conversations/:id",
  handle(async (req) => {
    const { title } = renameSchema.parse(req.body);

    return {
      conversation: await renameConversation({
        conversationId: req.params.id,
        userId: currentUser(req).id,
        title,
      }),
    };
  }),
);

chatRoutes.delete(
  "/conversations/:id",
  handle(async (req) =>
    deleteConversation({
      conversationId: req.params.id,
      userId: currentUser(req).id,
    }),
  ),
);
