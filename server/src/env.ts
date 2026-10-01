import "dotenv/config";

/**
 * Every environment variable the app reads, parsed once, in one place.
 *
 * Nothing else in the codebase touches `process.env` directly. That way a
 * missing key fails loudly at boot instead of as a confusing `undefined`
 * halfway through an agent run.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

/**
 * "openrouter" is a hosted LLM gateway rather than a model vendor: one key in
 * front of many providers, with its own failover. It speaks the OpenAI wire
 * format, so the OpenAI client talks to it unchanged.
 */
export type LlmProvider =
  | "google"
  | "openai"
  | "groq"
  | "anthropic"
  | "openrouter";

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProd: process.env.NODE_ENV === "production",

  port: Number(optional("PORT", "4000")),
  appUrl: optional("APP_URL", "http://localhost:5173"),
  serverUrl: optional("SERVER_URL", "http://localhost:4000"),

  sessionSecret: required("SESSION_SECRET"),

  llmProvider: optional("LLM_PROVIDER", "google") as LlmProvider,

  /**
   * Secondary provider the gateway tries when the primary keeps failing.
   * Empty disables fallback. Must differ from llmProvider to do anything.
   */
  llmFallbackProvider: (optional("LLM_FALLBACK_PROVIDER") ||
    undefined) as LlmProvider | undefined,

  /** Hard ceiling on one model call, so a hung provider cannot stall a request. */
  llmTimeoutMs: Number(optional("LLM_TIMEOUT_MS", "60000")),

  /** Retries on transient failures (429, 5xx) before the fallback is tried. */
  llmMaxRetries: Number(optional("LLM_MAX_RETRIES", "2")),

  google: {
    apiKey: optional("GOOGLE_API_KEY"),
    chatModel: optional("GOOGLE_CHAT_MODEL", "gemini-2.5-flash"),
    embeddingModel: optional("GOOGLE_EMBEDDING_MODEL", "gemini-embedding-001"),
  },
  openai: {
    apiKey: optional("OPENAI_API_KEY"),
    chatModel: optional("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
  },
  groq: {
    apiKey: optional("GROQ_API_KEY"),
    chatModel: optional("GROQ_CHAT_MODEL", "llama-3.3-70b-versatile"),
  },
  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY"),
    chatModel: optional("ANTHROPIC_CHAT_MODEL", "claude-sonnet-5"),
  },
  openrouter: {
    apiKey: optional("OPENROUTER_API_KEY"),
    chatModel: optional("OPENROUTER_CHAT_MODEL", "google/gemini-2.5-flash"),
  },

  oauth: {
    clientId: optional("GOOGLE_CLIENT_ID"),
    clientSecret: optional("GOOGLE_CLIENT_SECRET"),
    redirectUri: optional(
      "GOOGLE_REDIRECT_URI",
      "http://localhost:4000/api/auth/google/callback",
    ),
  },

  tavilyApiKey: optional("TAVILY_API_KEY"),

  reminderCron: optional("REMINDER_CRON", "*/5 * * * *"),
  reminderLeadMinutes: Number(optional("REMINDER_LEAD_MINUTES", "15")),

  /**
   * Serve the built frontend from this process.
   *
   * Off in development, where Vite serves it on its own port. On in production
   * it makes a single-container deploy possible and removes the CORS and
   * cookie-domain problem entirely, because the browser talks to one origin.
   */
  serveWeb: optional("SERVE_WEB", "false") === "true",
  webDistPath: optional("WEB_DIST_PATH", "../web/dist"),

  /**
   * Comma-separated extra origins allowed through CORS.
   * Needed only when the API and the UI are on different hosts.
   */
  extraCorsOrigins: optional("EXTRA_CORS_ORIGINS")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
} as const;

/** True when Google sign-in / Calendar / Gmail can actually be used. */
export const googleOAuthConfigured = Boolean(
  env.oauth.clientId && env.oauth.clientSecret,
);
