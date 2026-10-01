import { EventEmitter } from "node:events";
import { prisma } from "../db.js";

/**
 * Notifications: stored in the database, pushed live over SSE.
 *
 * Two halves:
 *  - `createNotification` writes a row (durable, survives a refresh)
 *  - `bus` emits it so any open SSE stream for that user shows it instantly
 *
 * A notification can carry a `dedupeKey`. The reminder cron re-runs every few
 * minutes and would otherwise create the same "meeting in 15 minutes" row over
 * and over; a unique (userId, dedupeKey) index makes the second write a no-op.
 */

export type NotificationKind = "meeting" | "mail" | "agent" | "system";

export type NotificationPayload = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
};

/** In-process pub/sub. Event name is the user id, so streams only see their own. */
export const bus = new EventEmitter();
// Plenty of headroom for many browser tabs per user.
bus.setMaxListeners(0);

export async function createNotification(input: {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string | null;
  dedupeKey?: string | null;
}): Promise<NotificationPayload | null> {
  // Treat a duplicate dedupeKey as "already delivered", not as an error.
  if (input.dedupeKey) {
    const existing = await prisma.notification.findFirst({
      where: { userId: input.userId, dedupeKey: input.dedupeKey },
      select: { id: true },
    });

    if (existing) return null;
  }

  const row = await prisma.notification.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      link: input.link ?? null,
      dedupeKey: input.dedupeKey ?? null,
    },
  });

  const payload: NotificationPayload = {
    id: row.id,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read,
    createdAt: row.createdAt.toISOString(),
  };

  bus.emit(input.userId, payload);

  return payload;
}

export async function listNotifications(input: {
  userId: string;
  limit?: number;
  unreadOnly?: boolean;
}): Promise<NotificationPayload[]> {
  const rows = await prisma.notification.findMany({
    where: {
      userId: input.userId,
      ...(input.unreadOnly ? { read: false } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: input.limit ?? 30,
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function unreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, read: false } });
}

export async function markRead(input: {
  userId: string;
  notificationId?: string;
}) {
  // No id means "mark everything read" (the Clear all button).
  await prisma.notification.updateMany({
    where: {
      userId: input.userId,
      ...(input.notificationId ? { id: input.notificationId } : {}),
    },
    data: { read: true },
  });

  return { ok: true, unread: await unreadCount(input.userId) };
}

export async function clearAll(userId: string) {
  await prisma.notification.deleteMany({ where: { userId } });
  return { ok: true };
}
