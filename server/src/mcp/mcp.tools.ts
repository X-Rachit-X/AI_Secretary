import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cancelMeeting,
  checkBusy,
  createMeeting,
  findFreeSlot,
  listMeetings,
} from "../google/calendar.js";
import { listMail, readMail, sendMail } from "../google/gmail.js";
import {
  createNotification,
  listNotifications,
} from "../services/notification.service.js";

/**
 * The same calendar, mail and notification capabilities, exposed over the
 * Model Context Protocol.
 *
 * Why this exists: the in-app agent is not the only client worth supporting.
 * Registering these tools on an MCP server lets Claude Desktop, Cursor or any
 * other MCP host drive the user's calendar and inbox directly, reusing the
 * exact functions in google/ that the web app uses. One implementation, two
 * ways in.
 *
 * Note the shape difference from the LangChain tools in ai/tools/: MCP
 * handlers must return a `content` array of typed blocks, not a bare string.
 */

/** MCP wants { content: [{ type: "text", text }] }, always. */
function textResult(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

/** Errors become readable text, not protocol failures the host cannot explain. */
async function guard(work: () => Promise<unknown>) {
  try {
    return textResult(await work());
  } catch (error) {
    return textResult({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Register every tool on a server instance.
 *
 * `userId` is bound at registration time, exactly as in the LangChain tools:
 * the model never gets to say whose data to touch.
 */
export function registerCortexTools(server: McpServer, userId: string) {
  // ── Calendar ────────────────────────────────────────────────────────────
  server.tool(
    "list_meetings",
    "List upcoming Google Calendar events. Set todayOnly for today's agenda.",
    {
      maxResults: z.number().int().min(1).max(20).optional(),
      todayOnly: z.boolean().optional(),
    },
    async ({ maxResults, todayOnly }) =>
      guard(() => listMeetings({ userId, maxResults, todayOnly })),
  );

  server.tool(
    "create_meeting",
    "Create a Google Calendar event with an optional Google Meet link, emailing the invitees.",
    {
      title: z.string().min(1),
      startIso: z.string(),
      endIso: z.string(),
      attendeeEmails: z.array(z.string()).optional(),
      description: z.string().optional(),
      addGoogleMeet: z.boolean().optional(),
    },
    async (input) => guard(() => createMeeting({ userId, ...input })),
  );

  server.tool(
    "cancel_meeting",
    "Cancel a Google Calendar event by id and notify the attendees.",
    { eventId: z.string().min(1) },
    async ({ eventId }) => guard(() => cancelMeeting({ userId, eventId })),
  );

  server.tool(
    "check_busy",
    "Check whether the user is busy between two ISO datetimes.",
    { startIso: z.string(), endIso: z.string() },
    async ({ startIso, endIso }) =>
      guard(() => checkBusy({ userId, startIso, endIso })),
  );

  server.tool(
    "find_free_slot",
    "Find the first free gap of a given length inside a time window.",
    {
      windowStartIso: z.string(),
      windowEndIso: z.string(),
      durationMinutes: z.number().int().min(5).max(480),
    },
    async (input) => guard(() => findFreeSlot({ userId, ...input })),
  );

  // ── Mail ────────────────────────────────────────────────────────────────
  server.tool(
    "search_mail",
    "Search Gmail using Gmail query syntax (is:unread, from:, newer_than:2d).",
    {
      query: z.string().optional(),
      maxResults: z.number().int().min(1).max(25).optional(),
    },
    async ({ query, maxResults }) =>
      guard(() => listMail({ userId, query, maxResults })),
  );

  server.tool(
    "read_mail",
    "Read one Gmail message in full, including its body.",
    { messageId: z.string().min(1) },
    async ({ messageId }) => guard(() => readMail({ userId, messageId })),
  );

  server.tool(
    "send_mail",
    "Send an email from the user's Gmail account.",
    {
      to: z.array(z.string()).min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
      cc: z.array(z.string()).optional(),
    },
    async (input) => guard(() => sendMail({ userId, ...input })),
  );

  // ── Notifications ───────────────────────────────────────────────────────
  server.tool(
    "create_reminder",
    "Add a notification to the user's CortexOne notification bell.",
    {
      title: z.string().min(1),
      body: z.string().optional(),
      link: z.string().optional(),
    },
    async ({ title, body, link }) =>
      guard(() =>
        createNotification({ userId, kind: "agent", title, body, link }),
      ),
  );

  server.tool(
    "list_notifications",
    "List the user's recent CortexOne notifications.",
    { unreadOnly: z.boolean().optional() },
    async ({ unreadOnly }) =>
      guard(() => listNotifications({ userId, unreadOnly, limit: 20 })),
  );

  return server;
}

export function buildMcpServer(userId: string) {
  const server = new McpServer({ name: "cortex-one", version: "1.0.0" });
  registerCortexTools(server, userId);
  return server;
}
