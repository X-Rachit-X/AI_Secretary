import type {
  AgentCatalogEntry,
  ChatMessage,
  Conversation,
  GoogleStatus,
  MailDetail,
  MailSummary,
  Meeting,
  Notification,
  StoredFile,
  User,
  Wallet,
} from "./types";

/**
 * The single HTTP client for the whole app.
 *
 * Two things every call needs and must never forget:
 *  - `credentials: "include"`, or the session cookie is not sent and every
 *    request comes back 401
 *  - error bodies unwrapped into a thrown Error, so components can use
 *    try/catch instead of checking a status on every call
 */

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;

  constructor(status: number, title: string, message: string) {
    super(message);
    this.status = status;
    this.title = title;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.title ?? "Request failed",
      data.message ?? response.statusText,
    );
  }

  return data as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

export const api = {
  // ── Auth ────────────────────────────────────────────────────────────────
  me: () =>
    get<{ user: User; wallet: Wallet; google: GoogleStatus }>("/api/auth/me"),

  /**
   * A full page navigation, not fetch: the OAuth consent screen has to run in
   * the browser's top-level window.
   */
  startGoogleLogin: () => {
    window.location.href = `${API_URL}/api/auth/google`;
  },

  logout: () => post<{ success: true }>("/api/auth/logout"),
  disconnectGoogle: () => post<{ success: true }>("/api/auth/google/disconnect"),

  // ── Conversations ───────────────────────────────────────────────────────
  listConversations: () =>
    get<{ conversations: Conversation[] }>("/api/chat/conversations"),
  createConversation: (title?: string) =>
    post<{ conversation: Conversation }>("/api/chat/conversations", { title }),
  listMessages: (id: string) =>
    get<{ messages: ChatMessage[] }>(`/api/chat/conversations/${id}/messages`),
  renameConversation: (id: string, title: string) =>
    patch<{ conversation: Conversation }>(`/api/chat/conversations/${id}`, {
      title,
    }),
  deleteConversation: (id: string) =>
    del<{ deleted: true }>(`/api/chat/conversations/${id}`),

  // ── Agents ──────────────────────────────────────────────────────────────
  agentCatalog: () => get<{ agents: AgentCatalogEntry[] }>("/api/agent/catalog"),

  // ── Calendar ────────────────────────────────────────────────────────────
  listMeetings: (params?: { todayOnly?: boolean; maxResults?: number }) => {
    const query = new URLSearchParams();
    if (params?.todayOnly) query.set("todayOnly", "true");
    if (params?.maxResults) query.set("maxResults", String(params.maxResults));

    return get<{ meetings: Meeting[] }>(
      `/api/calendar/meetings${query.size ? `?${query}` : ""}`,
    );
  },
  createMeeting: (input: {
    title: string;
    startIso: string;
    endIso: string;
    attendeeEmails?: string[];
    description?: string;
    addGoogleMeet?: boolean;
  }) => post<{ meeting: Meeting }>("/api/calendar/meetings", input),
  cancelMeeting: (eventId: string) =>
    del<{ cancelled: boolean }>(`/api/calendar/meetings/${eventId}`),

  // ── Mail ────────────────────────────────────────────────────────────────
  listMail: (query?: string, limit = 15) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (query) params.set("q", query);

    return get<{ messages: MailSummary[] }>(`/api/mail/messages?${params}`);
  },
  readMail: (id: string) =>
    get<{ message: MailDetail }>(`/api/mail/messages/${id}`),
  sendMail: (input: { to: string[]; subject: string; body: string }) =>
    post<{ sent: boolean }>("/api/mail/messages", input),
  replyMail: (id: string, body: string) =>
    post<{ sent: boolean }>(`/api/mail/messages/${id}/reply`, { body }),
  markMailRead: (id: string, read = true) =>
    patch<{ read: boolean }>(`/api/mail/messages/${id}/read`, { read }),
  mailStats: () =>
    get<{ unreadEstimate: number; inboxEstimate: number }>("/api/mail/stats"),

  // ── Notifications ───────────────────────────────────────────────────────
  listNotifications: () =>
    get<{ notifications: Notification[]; unread: number }>(
      "/api/notifications",
    ),
  markNotificationRead: (id?: string) =>
    post<{ unread: number }>("/api/notifications/read", { id }),
  clearNotifications: () => del<{ ok: true }>("/api/notifications"),
  sweepNotifications: () => post<{ ok: true }>("/api/notifications/sweep"),

  // ── Files ───────────────────────────────────────────────────────────────
  listFiles: () => get<{ files: StoredFile[] }>("/api/files"),
};
