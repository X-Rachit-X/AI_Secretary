import { gmailFor } from "./client.js";

/**
 * Gmail operations, in plain functions.
 *
 * Same shape as calendar.ts: no framework types, so the REST routes, the agent
 * tools and the MCP server all share one implementation.
 *
 * Two Gmail details drive most of the code here:
 *  1. Message bodies arrive base64url encoded and split across a nested MIME
 *     part tree, so extractBody walks it.
 *  2. messages.list returns ids only, so reading a list costs one extra
 *     messages.get per message. List sizes are capped to keep that bounded.
 */

export type MailSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string | null;
  unread: boolean;
  labels: string[];
};

export type MailDetail = MailSummary & { body: string };

type Header = { name?: string | null; value?: string | null };

function header(headers: Header[] | undefined, name: string) {
  const found = headers?.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

function decode(data: string | null | undefined) {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

type Part = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: Part[] | null;
};

/**
 * Depth-first search for readable text. Prefers text/plain and falls back to
 * text/html with tags stripped, because plenty of senders ship HTML only.
 */
function extractBody(payload: Part | undefined | null): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decode(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    const text = extractBody(part);
    if (text) return text;
  }

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decode(payload.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return decode(payload.body?.data);
}

function toSummary(message: {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  labelIds?: string[] | null;
  payload?: { headers?: Header[] | null } | null;
  internalDate?: string | null;
}): MailSummary {
  const headers = message.payload?.headers ?? undefined;

  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    from: header(headers, "From"),
    to: header(headers, "To"),
    subject: header(headers, "Subject") || "(no subject)",
    snippet: message.snippet?.trim() ?? "",
    date: message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : header(headers, "Date") || null,
    unread: (message.labelIds ?? []).includes("UNREAD"),
    labels: message.labelIds ?? [],
  };
}

/**
 * List messages matching a Gmail search query. The query uses normal Gmail
 * syntax, for example "is:unread" or "from:boss@acme.com newer_than:2d".
 */
export async function listMail(input: {
  userId: string;
  query?: string;
  maxResults?: number;
}): Promise<MailSummary[]> {
  const gmail = await gmailFor(input.userId);
  const max = Math.min(input.maxResults ?? 10, 25);

  const list = await gmail.users.messages.list({
    userId: "me",
    q: input.query || "in:inbox",
    maxResults: max,
  });

  const ids = (list.data.messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));

  // The metadata format skips the body, which is all a list view needs.
  const details = await Promise.all(
    ids.map((id) =>
      gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      }),
    ),
  );

  return details.map((response) => toSummary(response.data));
}

export async function readMail(input: {
  userId: string;
  messageId: string;
}): Promise<MailDetail> {
  const gmail = await gmailFor(input.userId);

  const response = await gmail.users.messages.get({
    userId: "me",
    id: input.messageId,
    format: "full",
  });

  const body = extractBody(response.data.payload as Part);

  return {
    ...toSummary(response.data),
    // Model context is finite and threads can be enormous.
    body: body.slice(0, 12000),
  };
}

/** RFC 2822 message, base64url encoded, which is what Gmail accepts. */
function buildRawMessage(input: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  inReplyTo?: string;
  references?: string;
}) {
  const lines = [
    `To: ${input.to.join(", ")}`,
    input.cc?.length ? `Cc: ${input.cc.join(", ")}` : null,
    `Subject: ${input.subject}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : null,
    input.references ? `References: ${input.references}` : null,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    input.body,
  ].filter((line): line is string => line !== null);

  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export async function sendMail(input: {
  userId: string;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
}) {
  const gmail = await gmailFor(input.userId);

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: buildRawMessage(input) },
  });

  return {
    sent: true,
    id: response.data.id ?? null,
    threadId: response.data.threadId ?? null,
    to: input.to,
    subject: input.subject,
  };
}

/**
 * Reply inside an existing thread.
 *
 * Passing threadId plus the original Message-Id in In-Reply-To is what keeps
 * Gmail from showing the reply as a brand new conversation.
 */
export async function replyToMail(input: {
  userId: string;
  messageId: string;
  body: string;
}) {
  const gmail = await gmailFor(input.userId);

  const original = await gmail.users.messages.get({
    userId: "me",
    id: input.messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Message-Id", "References"],
  });

  const headers = original.data.payload?.headers ?? undefined;
  const from = header(headers, "From");
  const subject = header(headers, "Subject");
  const messageIdHeader = header(headers, "Message-Id");
  const references = header(headers, "References");

  const raw = buildRawMessage({
    to: [from],
    subject: subject.toLowerCase().startsWith("re:")
      ? subject
      : `Re: ${subject}`,
    body: input.body,
    inReplyTo: messageIdHeader,
    references: [references, messageIdHeader].filter(Boolean).join(" "),
  });

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: original.data.threadId ?? undefined },
  });

  return { sent: true, id: response.data.id ?? null, to: from, subject };
}

export async function markMailRead(input: {
  userId: string;
  messageId: string;
  read?: boolean;
}) {
  const gmail = await gmailFor(input.userId);
  const read = input.read !== false;

  await gmail.users.messages.modify({
    userId: "me",
    id: input.messageId,
    requestBody: read
      ? { removeLabelIds: ["UNREAD"] }
      : { addLabelIds: ["UNREAD"] },
  });

  return { messageId: input.messageId, read };
}

/** Counts for the Mail page header and the morning digest notification. */
export async function mailStats(userId: string) {
  const gmail = await gmailFor(userId);

  const [unread, inbox] = await Promise.all([
    gmail.users.messages.list({
      userId: "me",
      q: "is:unread in:inbox",
      maxResults: 1,
    }),
    gmail.users.messages.list({ userId: "me", q: "in:inbox", maxResults: 1 }),
  ]);

  return {
    unreadEstimate: unread.data.resultSizeEstimate ?? 0,
    inboxEstimate: inbox.data.resultSizeEstimate ?? 0,
  };
}
