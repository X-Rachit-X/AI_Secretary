import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { parseJsonArray } from "../lib/time.js";

/**
 * Conversations and messages: the chat sidebar and the transcript.
 *
 * Also the short-term memory the agents read. The original project put a Redis
 * cache in front of MongoDB for this; with SQLite on the same machine the read
 * is already sub-millisecond, so the cache is pure complexity and is gone.
 */

export type Artifact = {
  id: string;
  type: "project" | "document" | "deck";
  title: string;
  files: Array<{ name: string; content: string }>;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  agent: string | null;
  images: string[];
  artifacts: Artifact[];
  createdAt: string;
};

/** Ownership check used by every function below. 404, not 403: never leak which ids exist. */
async function assertOwned(conversationId: string, userId: string) {
  const found = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });

  if (!found) throw AppError.notFound("Conversation");
  return found;
}

export async function createConversation(userId: string, title?: string) {
  return prisma.conversation.create({
    data: { userId, title: title?.trim() || "New chat" },
  });
}

export async function listConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
}

export async function renameConversation(input: {
  conversationId: string;
  userId: string;
  title: string;
}) {
  await assertOwned(input.conversationId, input.userId);

  return prisma.conversation.update({
    where: { id: input.conversationId },
    data: { title: input.title.trim().slice(0, 120) || "New chat" },
  });
}

export async function deleteConversation(input: {
  conversationId: string;
  userId: string;
}) {
  await assertOwned(input.conversationId, input.userId);
  // Messages cascade via the relation in schema.prisma.
  await prisma.conversation.delete({ where: { id: input.conversationId } });
  return { deleted: true };
}

function toChatMessage(row: {
  id: string;
  role: string;
  content: string;
  agent: string | null;
  images: string;
  artifacts: string;
  createdAt: Date;
}): ChatMessage {
  return {
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    content: row.content,
    agent: row.agent,
    images: parseJsonArray<string>(row.images),
    artifacts: parseJsonArray<Artifact>(row.artifacts),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMessages(input: {
  conversationId: string;
  userId: string;
}): Promise<ChatMessage[]> {
  await assertOwned(input.conversationId, input.userId);

  const rows = await prisma.message.findMany({
    where: { conversationId: input.conversationId },
    orderBy: { createdAt: "asc" },
  });

  return rows.map(toChatMessage);
}

export async function saveMessage(input: {
  conversationId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  agent?: string | null;
  images?: string[];
  artifacts?: Artifact[];
}): Promise<ChatMessage> {
  await assertOwned(input.conversationId, input.userId);

  const row = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      agent: input.agent ?? null,
      images: JSON.stringify(input.images ?? []),
      artifacts: JSON.stringify(input.artifacts ?? []),
    },
  });

  // Bumps the sidebar ordering, which sorts by updatedAt.
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { updatedAt: new Date() },
  });

  return toChatMessage(row);
}

/**
 * The last N turns, oldest first: exactly what gets replayed into the model.
 *
 * Capped because context is finite and the tail of a conversation carries
 * nearly all the useful signal.
 */
export async function recentHistory(input: {
  conversationId: string;
  userId: string;
  limit?: number;
}): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  await assertOwned(input.conversationId, input.userId);

  const rows = await prisma.message.findMany({
    where: { conversationId: input.conversationId },
    orderBy: { createdAt: "desc" },
    take: input.limit ?? 20,
    select: { role: true, content: true },
  });

  return rows
    .reverse()
    .map((row) => ({
      role: row.role === "user" ? ("user" as const) : ("assistant" as const),
      content: row.content,
    }))
    .filter((row) => row.content.trim().length > 0);
}

/**
 * Title a brand new thread from its first user message, so the sidebar is not
 * a wall of "New chat". Only ever runs once per conversation.
 */
export async function autoTitle(input: {
  conversationId: string;
  userId: string;
  firstMessage: string;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, userId: input.userId },
    select: { id: true, title: true },
  });

  if (!conversation || conversation.title !== "New chat") return;

  const title = input.firstMessage.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!title) return;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { title },
  });
}
