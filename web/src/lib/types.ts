/**
 * Every shape the API returns.
 *
 * These mirror the server types by hand. A shared package would remove the
 * duplication, but it also adds a build step to a project whose whole point is
 * being easy to follow. The surface is small enough that keeping the two in
 * step is a matter of reading one file.
 */

export type AgentId =
  | "auto"
  | "chat"
  | "search"
  | "coding"
  | "pdf"
  | "ppt"
  | "image"
  | "vision"
  | "docqa"
  | "workspace";

export type User = {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
};

export type Wallet = { credits: number; totalCredits: number };

export type GoogleStatus = { connected: boolean; scopes: string[] };

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

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

/** A message that is still streaming has no id yet. */
export type PendingMessage = {
  role: "assistant";
  status: string;
  content: string;
};

export type AgentStreamEvent =
  | { type: "started" }
  | { type: "progress"; message: string }
  | { type: "completed"; message: ChatMessage; wallet: Wallet }
  | { type: "error"; title: string; message: string; status?: number };

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

export type Notification = {
  id: string;
  kind: "meeting" | "mail" | "agent" | "system";
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
};

export type StoredFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
};

export type AgentCatalogEntry = {
  id: AgentId;
  label: string;
  hint: string;
};
