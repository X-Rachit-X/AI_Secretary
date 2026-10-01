import { Router } from "express";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import {
  bus,
  clearAll,
  listNotifications,
  markRead,
  unreadCount,
  type NotificationPayload,
} from "../services/notification.service.js";
import { runSweepNow } from "../services/scheduler.service.js";
import { openSseStream } from "../lib/sse.js";
import { statusOf, toErrorBody } from "../lib/errors.js";

/**
 * Notifications: the list, the badge count, and the live feed.
 *
 * `GET /stream` is the interesting one. It subscribes to the in-process event
 * bus for this user and forwards every new notification down an SSE
 * connection, so the bell updates the moment the cron creates something
 * without the browser polling.
 */

export const notificationRoutes = Router();

notificationRoutes.use(requireAuth);

function handle(fn: (req: any) => Promise<unknown>) {
  return async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      res.status(statusOf(error)).json(toErrorBody(error));
    }
  };
}

notificationRoutes.get(
  "/",
  handle(async (req) => {
    const userId = currentUser(req).id;

    return {
      notifications: await listNotifications({
        userId,
        unreadOnly: req.query.unread === "true",
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
      unread: await unreadCount(userId),
    };
  }),
);

notificationRoutes.post(
  "/read",
  handle(async (req) =>
    markRead({
      userId: currentUser(req).id,
      notificationId:
        typeof req.body?.id === "string" ? req.body.id : undefined,
    }),
  ),
);

notificationRoutes.delete(
  "/",
  handle(async (req) => clearAll(currentUser(req).id)),
);

/** Manual trigger for the reminder sweep, so you can test without waiting. */
notificationRoutes.post(
  "/sweep",
  handle(async () => runSweepNow()),
);

notificationRoutes.get("/stream", async (req, res) => {
  const userId = currentUser(req).id;
  const stream = openSseStream(res);

  // Send the current state immediately so the bell is correct on first paint
  // rather than empty until something happens.
  stream.send({
    type: "snapshot",
    notifications: await listNotifications({ userId, limit: 20 }),
    unread: await unreadCount(userId),
  });

  const onNotification = (payload: NotificationPayload) => {
    stream.send({ type: "notification", notification: payload });
  };

  bus.on(userId, onNotification);

  // Without this the listener leaks on every closed tab and the bus grows
  // until it warns about max listeners.
  req.on("close", () => {
    bus.off(userId, onNotification);
    stream.close();
  });
});
