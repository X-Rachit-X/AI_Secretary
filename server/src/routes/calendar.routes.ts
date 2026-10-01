import { Router } from "express";
import { z } from "zod";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import {
  cancelMeeting,
  checkBusy,
  createMeeting,
  findFreeSlot,
  getMeeting,
  listMeetings,
  rescheduleMeeting,
} from "../google/calendar.js";
import { statusOf, toErrorBody } from "../lib/errors.js";

/**
 * REST access to the same calendar functions the agent tools call.
 *
 * This is what powers the Calendar page: a plain list and the New meeting
 * form. The agent is great for "move my 3pm", but clicking a day and seeing
 * what is on it should not cost an LLM call.
 */

export const calendarRoutes = Router();

calendarRoutes.use(requireAuth);

function handle(fn: (req: any) => Promise<unknown>) {
  return async (req: any, res: any) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      res.status(statusOf(error)).json(toErrorBody(error));
    }
  };
}

calendarRoutes.get(
  "/meetings",
  handle(async (req) => ({
    meetings: await listMeetings({
      userId: currentUser(req).id,
      todayOnly: req.query.todayOnly === "true",
      maxResults: req.query.maxResults
        ? Number(req.query.maxResults)
        : undefined,
      timeMinIso:
        typeof req.query.from === "string" ? req.query.from : undefined,
      timeMaxIso: typeof req.query.to === "string" ? req.query.to : undefined,
    }),
  })),
);

calendarRoutes.get(
  "/meetings/:eventId",
  handle(async (req) => ({
    meeting: await getMeeting({
      userId: currentUser(req).id,
      eventId: req.params.eventId,
    }),
  })),
);

const createSchema = z.object({
  title: z.string().min(1),
  startIso: z.string().min(1),
  endIso: z.string().min(1),
  attendeeEmails: z.array(z.string()).optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  addGoogleMeet: z.boolean().optional(),
});

calendarRoutes.post(
  "/meetings",
  handle(async (req) => ({
    meeting: await createMeeting({
      userId: currentUser(req).id,
      ...createSchema.parse(req.body),
    }),
  })),
);

const rescheduleSchema = z.object({
  startIso: z.string().min(1),
  endIso: z.string().min(1),
});

calendarRoutes.patch(
  "/meetings/:eventId",
  handle(async (req) => ({
    meeting: await rescheduleMeeting({
      userId: currentUser(req).id,
      eventId: req.params.eventId,
      ...rescheduleSchema.parse(req.body),
    }),
  })),
);

calendarRoutes.delete(
  "/meetings/:eventId",
  handle(async (req) =>
    cancelMeeting({
      userId: currentUser(req).id,
      eventId: req.params.eventId,
    }),
  ),
);

calendarRoutes.get(
  "/busy",
  handle(async (req) =>
    checkBusy({
      userId: currentUser(req).id,
      startIso: String(req.query.from),
      endIso: String(req.query.to),
    }),
  ),
);

calendarRoutes.get(
  "/free-slot",
  handle(async (req) =>
    findFreeSlot({
      userId: currentUser(req).id,
      windowStartIso: String(req.query.from),
      windowEndIso: String(req.query.to),
      durationMinutes: Number(req.query.minutes ?? 30),
    }),
  ),
);
