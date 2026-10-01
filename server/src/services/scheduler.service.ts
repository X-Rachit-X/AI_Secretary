import cron from "node-cron";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { listMeetings } from "../google/calendar.js";
import { listMail } from "../google/gmail.js";
import { humanTime } from "../lib/time.js";
import { createNotification } from "./notification.service.js";

/**
 * The background job that makes notifications happen on their own.
 *
 * Every REMINDER_CRON tick, for each user with a Google grant:
 *  - meetings starting within REMINDER_LEAD_MINUTES  -> a "meeting" reminder
 *  - mail that arrived in the last hour and is unread -> a "mail" nudge
 *
 * Every notification carries a dedupeKey, so a tick that sees the same meeting
 * again writes nothing. That is what makes it safe to run this often.
 */

async function remindAboutMeetings(userId: string) {
  const now = Date.now();
  const horizon = now + env.reminderLeadMinutes * 60_000;

  const meetings = await listMeetings({
    userId,
    maxResults: 10,
    timeMinIso: new Date(now).toISOString(),
    timeMaxIso: new Date(horizon).toISOString(),
  });

  for (const meeting of meetings) {
    if (!meeting.id || !meeting.start) continue;

    const minutesAway = Math.max(
      0,
      Math.round((new Date(meeting.start).getTime() - now) / 60_000),
    );

    await createNotification({
      userId,
      kind: "meeting",
      title: meeting.title,
      body:
        minutesAway === 0
          ? `Starting now (${humanTime(meeting.start)})`
          : `Starts in ${minutesAway} min (${humanTime(meeting.start)})`,
      link: meeting.meetLink ?? meeting.htmlLink,
      dedupeKey: `meeting:${meeting.id}`,
    });
  }
}

async function nudgeAboutMail(userId: string) {
  // newer_than:1h keeps the Gmail query cheap and the nudges timely.
  const messages = await listMail({
    userId,
    query: "is:unread in:inbox newer_than:1h",
    maxResults: 5,
  });

  for (const message of messages) {
    await createNotification({
      userId,
      kind: "mail",
      title: message.subject,
      body: `From ${message.from}`,
      link: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
      dedupeKey: `mail:${message.id}`,
    });
  }
}

async function tick() {
  const accounts = await prisma.googleAccount.findMany({
    select: { userId: true },
  });

  for (const account of accounts) {
    // One user's expired grant must not stop the sweep for everyone else.
    await remindAboutMeetings(account.userId).catch((error) => {
      console.warn(`[scheduler] meetings ${account.userId}:`, error.message);
    });

    await nudgeAboutMail(account.userId).catch((error) => {
      console.warn(`[scheduler] mail ${account.userId}:`, error.message);
    });
  }
}

export function startScheduler() {
  if (!cron.validate(env.reminderCron)) {
    console.warn(
      `[scheduler] REMINDER_CRON "${env.reminderCron}" is not a valid cron expression; scheduler disabled.`,
    );
    return;
  }

  cron.schedule(env.reminderCron, () => {
    tick().catch((error) => console.error("[scheduler] tick failed:", error));
  });

  console.log(`[scheduler] reminder sweep scheduled: ${env.reminderCron}`);
}

/** Exported so the Notifications page can offer a "Check now" button. */
export async function runSweepNow() {
  await tick();
  return { ok: true };
}
