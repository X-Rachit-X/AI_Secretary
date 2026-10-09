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

/** Token and cost accounting for one run, from the LLM gateway. */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelCalls: number;
  cacheHits: number;
  retries: number;
  fallbacks: number;
};

/**
 * An irreversible action the agent proposed but did NOT perform.
 * The user approves or rejects it; see guardrails/tool.guard.ts on the server.
 */
export type PendingApproval = {
  id: string;
  tool: string;
  summary: string;
  args: Record<string, unknown>;
  conversationId?: string;
  expiresAt: string;
};

export type AgentStreamEvent =
  | { type: "started" }
  | { type: "progress"; message: string }
  | {
      type: "completed";
      message: ChatMessage;
      wallet: Wallet;
      approvals: PendingApproval[];
      usage: Usage;
      flags: string[];
    }
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

// ── Observability ───────────────────────────────────────────────────────────

export type TraceRow = {
  id: string;
  agent: string;
  latencyMs: number;
  tokens: number;
  costUsd: number;
  modelCalls: number;
  flags: string[];
  ok: boolean;
  errorTitle: string | null;
  createdAt: string;
};

export type InsightsSummary = {
  runs: number;
  okRate: number;
  totalCostUsd: number;
  totalTokens: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  byAgent: Array<{
    agent: string;
    runs: number;
    avgLatencyMs: number;
    costUsd: number;
    errorRate: number;
  }>;
  topFlags: Array<{ flag: string; count: number }>;
};

export type GatewayInfo = {
  provider: string;
  fallbackProvider: string | null;
  timeoutMs: number;
  maxRetries: number;
  googleTimeoutMs: number;
  cache: {
    entries: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    /** null when nothing has been looked up yet — not the same as 0%. */
    hitRate: number | null;
    ttlMs: number;
    cacheableRoles: string[];
  };
  /** Embeddings are a pure function of (text, model), so this is free to cache. */
  embeddingCache: {
    entries: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRate: number | null;
  };
};

/** The live guardrail policy, read from the server so the UI cannot drift. */
export type GuardrailPolicy = {
  maxPromptLength: number;
  secretTypesDetected: string[];
  blockedIntents: string[];
  requiresApproval: string[];
  maxWritesPerTurn: number;
  maxRecipientsPerMessage: number;
};
