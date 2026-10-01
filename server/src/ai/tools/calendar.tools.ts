import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  checkBusy,
  createMeeting,
  findFreeSlot,
  getMeeting,
  listMeetings,
  rescheduleMeeting,
} from "../../google/calendar.js";
import { proposeAction } from "../../guardrails/index.js";
import {
  tracked,
  untrusted,
  type ToolContext,
  type ToolCounters,
} from "./context.js";

/**
 * Google Calendar as LangChain tools.
 *
 * These are thin wrappers: all the Google logic lives in google/calendar.ts.
 * What they add is the schema and the description, and those two things are
 * the actual prompt engineering here. The model only ever sees the tool name,
 * its description and its input schema, so a vague description is the usual
 * reason an agent calls the wrong tool.
 *
 * Two guardrails show up:
 *   - event titles, descriptions and attendee names come from other people, so
 *     listings are wrapped as untrusted content
 *   - cancel_meeting proposes rather than cancels; a human approves it
 *
 * `context` is closed over rather than passed as a tool argument. A model must
 * never be in a position to name whose calendar to read.
 */
export function createCalendarTools(
  context: ToolContext,
  counters: ToolCounters,
) {
  return [
    tool(
      tracked(counters, "list_meetings", async (args: {
        maxResults?: number;
        todayOnly?: boolean;
      }) =>
        untrusted(
          counters,
          "google-calendar",
          await listMeetings({ userId: context.userId, ...args }),
        ),
      ),
      {
        name: "list_meetings",
        description:
          "List the user's upcoming Google Calendar events. Set todayOnly=true for today's agenda only. Returns event ids needed by reschedule and cancel.",
        schema: z.object({
          maxResults: z.number().int().min(1).max(20).optional(),
          todayOnly: z
            .boolean()
            .optional()
            .describe("True for today only, false or omitted for upcoming"),
        }),
      },
    ),

    tool(
      tracked(counters, "get_meeting", async ({ eventId }: { eventId: string }) =>
        untrusted(
          counters,
          "google-calendar",
          await getMeeting({ userId: context.userId, eventId }),
        ),
      ),
      {
        name: "get_meeting",
        description:
          "Fetch one event in full (description, attendees, location, links) by its id. Use when the user asks what a meeting is about.",
        schema: z.object({ eventId: z.string().min(1) }),
      },
    ),

    tool(
      tracked(counters, "create_meeting", (args: {
        title: string;
        startIso: string;
        endIso: string;
        attendeeEmails?: string[];
        description?: string;
        location?: string;
        addGoogleMeet?: boolean;
      }) => createMeeting({ userId: context.userId, ...args })),
      {
        name: "create_meeting",
        description:
          "Create a Google Calendar event. Adds a Google Meet link by default and emails the invitees. Times must be ISO-8601 with an offset. This runs immediately; no approval needed.",
        schema: z.object({
          title: z.string().min(1),
          startIso: z.string().describe("Start time, ISO-8601 with offset"),
          endIso: z.string().describe("End time, ISO-8601 with offset"),
          attendeeEmails: z
            .array(z.string())
            .optional()
            .describe("Google emails a calendar invite to each address"),
          description: z.string().optional(),
          location: z.string().optional(),
          addGoogleMeet: z
            .boolean()
            .optional()
            .describe("Defaults to true. Set false to skip the Meet link"),
        }),
      },
    ),

    tool(
      tracked(counters, "reschedule_meeting", (args: {
        eventId: string;
        startIso: string;
        endIso: string;
      }) => rescheduleMeeting({ userId: context.userId, ...args })),
      {
        name: "reschedule_meeting",
        description:
          "Move an existing event to a new start and end time, emailing the attendees. Needs the event id from list_meetings.",
        schema: z.object({
          eventId: z.string().min(1),
          startIso: z.string(),
          endIso: z.string(),
        }),
      },
    ),

    /**
     * Cancelling emails every attendee and cannot be undone, so this tool does
     * NOT cancel anything. It records a proposal and returns an id; the user
     * approves it in the UI and the server then performs the cancellation with
     * exactly these arguments.
     */
    tool(
      tracked(counters, "cancel_meeting", (args: { eventId: string }) =>
        proposeAction(context, "cancel_meeting", args).then(JSON.parse),
      ),
      {
        name: "cancel_meeting",
        description:
          "Propose cancelling an event. This does NOT cancel it: the user must approve first. Returns status=approval_required with a summary you should describe to them.",
        schema: z.object({ eventId: z.string().min(1) }),
      },
    ),

    tool(
      tracked(counters, "check_busy", (args: {
        startIso: string;
        endIso: string;
      }) => checkBusy({ userId: context.userId, ...args })),
      {
        name: "check_busy",
        description:
          "Check whether the user is busy between two times. Returns busy intervals only, no event details. Use for 'am I free at...' questions.",
        schema: z.object({ startIso: z.string(), endIso: z.string() }),
      },
    ),

    tool(
      tracked(counters, "find_free_slot", (args: {
        windowStartIso: string;
        windowEndIso: string;
        durationMinutes: number;
      }) => findFreeSlot({ userId: context.userId, ...args })),
      {
        name: "find_free_slot",
        description:
          "Find the first gap of a given length inside a time window. Use for 'find me 30 minutes tomorrow' instead of guessing a time and checking it.",
        schema: z.object({
          windowStartIso: z.string(),
          windowEndIso: z.string(),
          durationMinutes: z.number().int().min(5).max(480),
        }),
      },
    ),
  ];
}
