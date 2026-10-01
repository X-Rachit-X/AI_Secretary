import { Router } from "express";
import { z } from "zod";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import {
  listMail,
  mailStats,
  markMailRead,
  readMail,
  replyToMail,
  sendMail,
} from "../google/gmail.js";
import { statusOf, toErrorBody } from "../lib/errors.js";

/**
 * REST access to Gmail, backing the Mail page.
 *
 * Mirrors calendar.routes.ts exactly: same functions as the agent tools, no
 * LLM in the path. Browsing an inbox should be instant and free.
 */

export const mailRoutes = Router();

mailRoutes.use(requireAuth);

function handle(fn: (req: any) => Promise<unknown>) {
  return async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      res.status(statusOf(error)).json(toErrorBody(error));
    }
  };
}

mailRoutes.get(
  "/messages",
  handle(async (req) => ({
    messages: await listMail({
      userId: currentUser(req).id,
      query: typeof req.query.q === "string" ? req.query.q : undefined,
      maxResults: req.query.limit ? Number(req.query.limit) : undefined,
    }),
  })),
);

mailRoutes.get(
  "/messages/:messageId",
  handle(async (req) => ({
    message: await readMail({
      userId: currentUser(req).id,
      messageId: req.params.messageId,
    }),
  })),
);

const sendSchema = z.object({
  to: z.array(z.string()).min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  cc: z.array(z.string()).optional(),
});

mailRoutes.post(
  "/messages",
  handle(async (req) =>
    sendMail({ userId: currentUser(req).id, ...sendSchema.parse(req.body) }),
  ),
);

const replySchema = z.object({ body: z.string().min(1) });

mailRoutes.post(
  "/messages/:messageId/reply",
  handle(async (req) =>
    replyToMail({
      userId: currentUser(req).id,
      messageId: req.params.messageId,
      ...replySchema.parse(req.body),
    }),
  ),
);

mailRoutes.patch(
  "/messages/:messageId/read",
  handle(async (req) =>
    markMailRead({
      userId: currentUser(req).id,
      messageId: req.params.messageId,
      read: req.body?.read !== false,
    }),
  ),
);

mailRoutes.get(
  "/stats",
  handle(async (req) => mailStats(currentUser(req).id)),
);
