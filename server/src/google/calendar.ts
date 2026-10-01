import { randomUUID } from "node:crypto";
import { calendarFor } from "./client.js";
import { endOfToday, startOfToday } from "../lib/time.js";

/**
 * Google Calendar operations, in plain functions.
 *
 * Deliberately free of any LangChain or Express types: the same functions back
 * the REST routes (the Calendar page), the agent tools (chat with calendar)
 * and the MCP server (Claude Desktop / Cursor). One implementation, three
 * front doors.
 */

export type Meeting = {
  id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
  htmlLink: string | null;
  meetLink: string | null;
  attendees: string[];
};

type RawEvent = {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  htmlLink?: string | null;
  hangoutLink?: string | null;
  attendees?: Array<{ email?: string | null; displayName?: string | null }> | null;
};

/**
 * Google returns `dateTime` for timed events and `date` for all-day ones.
 * Flattening both into one `start` string keeps every consumer simple.
 */
function formatEvent(event: RawEvent): Meeting {
  return {
    id: event.id ?? null,
    title: event.summary ?? "(no title)",
    description: event.description?.trim() || null,
    location: event.location?.trim() || null,
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    htmlLink: event.htmlLink ?? null,
    meetLink: event.hangoutLink ?? null,
    attendees: (event.attendees ?? [])
      .map((person) => person.email || person.displayName)
      .filter((value): value is string => Boolean(value)),
  };
}

export async function listMeetings(input: {
  userId: string;
  maxResults?: number;
  todayOnly?: boolean;
  timeMinIso?: string;
  timeMaxIso?: string;
}): Promise<Meeting[]> {
  const calendar = await calendarFor(input.userId);

  let timeMin = input.timeMinIso ?? new Date().toISOString();
  let timeMax = input.timeMaxIso;

  if (input.todayOnly) {
    timeMin = startOfToday().toISOString();
    timeMax = endOfToday().toISOString();
  }

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    maxResults: input.maxResults ?? 10,
    // Expands a recurring event into its individual occurrences, which is what
    // "my next three meetings" should mean.
    singleEvents: true,
    orderBy: "startTime",
  });

  return (response.data.items ?? []).map(formatEvent);
}

export async function getMeeting(input: { userId: string; eventId: string }) {
  const calendar = await calendarFor(input.userId);

  const response = await calendar.events.get({
    calendarId: "primary",
    eventId: input.eventId,
  });

  return formatEvent(response.data);
}

export async function createMeeting(input: {
  userId: string;
  title: string;
  startIso: string;
  endIso: string;
  attendeeEmails?: string[];
  description?: string;
  location?: string;
  addGoogleMeet?: boolean;
}) {
  const calendar = await calendarFor(input.userId);
  const withMeet = input.addGoogleMeet !== false;

  const response = await calendar.events.insert({
    calendarId: "primary",
    // Google emails the invitees for us.
    sendUpdates: "all",
    // Required for Google to actually mint the Meet link.
    conferenceDataVersion: withMeet ? 1 : undefined,
    requestBody: {
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startIso },
      end: { dateTime: input.endIso },
      attendees: (input.attendeeEmails ?? []).map((email) => ({ email })),
      conferenceData: withMeet
        ? {
            createRequest: {
              requestId: randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          }
        : undefined,
    },
  });

  return {
    ...formatEvent(response.data),
    inviteEmailsSent: (input.attendeeEmails ?? []).length > 0,
    googleMeetAdded: withMeet,
  };
}

export async function rescheduleMeeting(input: {
  userId: string;
  eventId: string;
  startIso: string;
  endIso: string;
}) {
  const calendar = await calendarFor(input.userId);

  const response = await calendar.events.patch({
    calendarId: "primary",
    eventId: input.eventId,
    sendUpdates: "all",
    requestBody: {
      start: { dateTime: input.startIso },
      end: { dateTime: input.endIso },
    },
  });

  return formatEvent(response.data);
}

export async function cancelMeeting(input: {
  userId: string;
  eventId: string;
}) {
  const calendar = await calendarFor(input.userId);

  await calendar.events.delete({
    calendarId: "primary",
    eventId: input.eventId,
    sendUpdates: "all",
  });

  return { cancelled: true, eventId: input.eventId };
}

/**
 * Busy blocks between two times. Cheaper and more private than listing events:
 * freebusy returns only intervals, never titles or attendees.
 */
export async function checkBusy(input: {
  userId: string;
  startIso: string;
  endIso: string;
}) {
  const calendar = await calendarFor(input.userId);

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: input.startIso,
      timeMax: input.endIso,
      items: [{ id: "primary" }],
    },
  });

  const busy = response.data?.calendars?.primary?.busy ?? [];

  return {
    busy: busy.map((slot) => ({
      start: slot.start ?? null,
      end: slot.end ?? null,
    })),
    isFree: busy.length === 0,
  };
}

/**
 * First gap of `durationMinutes` inside the window that does not overlap a
 * busy block. Lets the agent answer "find me 30 minutes tomorrow" with one
 * tool call instead of guessing and re-checking.
 */
export async function findFreeSlot(input: {
  userId: string;
  windowStartIso: string;
  windowEndIso: string;
  durationMinutes: number;
}) {
  const { busy } = await checkBusy({
    userId: input.userId,
    startIso: input.windowStartIso,
    endIso: input.windowEndIso,
  });

  const windowEnd = new Date(input.windowEndIso).getTime();
  const durationMs = input.durationMinutes * 60000;

  const blocks = busy
    .map((slot) => ({
      start: new Date(slot.start ?? 0).getTime(),
      end: new Date(slot.end ?? 0).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  let cursor = new Date(input.windowStartIso).getTime();

  for (const block of blocks) {
    if (block.start - cursor >= durationMs) break;
    cursor = Math.max(cursor, block.end);
  }

  if (cursor + durationMs > windowEnd) {
    return { found: false as const, reason: "No free slot in that window." };
  }

  return {
    found: true as const,
    startIso: new Date(cursor).toISOString(),
    endIso: new Date(cursor + durationMs).toISOString(),
  };
}
