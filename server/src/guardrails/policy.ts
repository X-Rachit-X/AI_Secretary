/**
 * Every guardrail knob, in one file.
 *
 * Guardrails are only useful if you can see what they do without reading the
 * code that enforces them. Keeping the thresholds, patterns and tool lists
 * here means a reviewer can audit the policy in one screen, and tuning it
 * never means touching enforcement logic.
 *
 * The four layers, and what each is actually for:
 *
 *   1. INPUT   — what the user sends us. Mostly about not forwarding their
 *                own secrets to a third-party model.
 *   2. CONTENT — what the model is asked to produce. Deliberately narrow.
 *   3. TOOL    — what the agent is allowed to DO. The important one: this is
 *                the layer between a language model and someone's real inbox.
 *   4. OUTPUT  — what we show back. Catches leaked prompts and secrets that
 *                arrived via tool results.
 */

export const POLICY = {
  input: {
    /** Characters. Longer prompts are rejected before any model call. */
    maxPromptLength: 8000,

    /**
     * Phrases that try to override the system prompt.
     *
     * This is a heuristic, not a wall. It exists to catch the lazy 90% and to
     * mark a turn as suspicious so the model gets an extra defensive note. The
     * real protection against injection is the tool layer: an agent that
     * cannot send mail without approval cannot be talked into sending mail.
     */
    injectionPatterns: [
      /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
      /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|rules?|training)/i,
      /forget\s+(everything|all)\s+(you|above|before)/i,
      /(reveal|show|print|repeat|output)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions?)/i,
      /you\s+are\s+now\b/i,
      /\b(developer|god|admin|root|dan)\s+mode\b/i,
      /pretend\s+(you\s+)?(are|to\s+be)\s+(not\s+)?(an?\s+)?(ai|assistant|bound)/i,
      /<\|?(im_start|im_end|system|endoftext)\|?>/i,
      /\bBEGIN\s+SYSTEM\s+PROMPT\b/i,
    ],

    /**
     * Credentials. These are REDACTED, never blocked.
     *
     * A user pasting a stack trace that happens to contain a key should still
     * get help; what must not happen is that key travelling to an LLM provider
     * and sitting in someone's logs forever.
     *
     * ORDER AND SPECIFICITY MATTER HERE, and an eval case exists because this
     * went wrong once: an Anthropic key starts "sk-ant-", which also satisfies
     * the generic OpenAI "sk-" shape. The specific pattern is listed first AND
     * the generic one excludes it with a lookahead, so a key is always labelled
     * with the provider it actually belongs to.
     */
    secretPatterns: [
      { label: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
      { label: "openai_key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
      { label: "google_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
      { label: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
      { label: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
      { label: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
      { label: "private_key", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/g },
      { label: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/g },
    ],
  },

  content: {
    /**
     * Narrow on purpose.
     *
     * The providers already refuse genuinely harmful requests, and a long
     * keyword blocklist in front of them mostly produces false positives on
     * ordinary work ("kill the process", "attack surface", "exploit the gap in
     * the market"). What is listed here is the small set where this app
     * specifically must not help, because it has a real mailbox attached.
     */
    blockedIntents: [
      {
        label: "mass_mail",
        pattern:
          /\b(send|blast|email)\b.{0,40}\b(everyone|all\s+(my\s+)?contacts|entire\s+(contact\s+)?list|mailing\s+list)\b/i,
        message:
          "I can't send mail to a whole contact list. Name the recipients and I'll help with that.",
      },
      {
        label: "credential_phishing",
        pattern:
          /\b(write|draft|compose|create)\b.{0,60}\b(phish|phishing|fake\s+(login|invoice|receipt)|impersonat\w*)\b/i,
        message:
          "I can't write messages designed to deceive the person receiving them.",
      },
      {
        label: "exfiltration",
        pattern:
          /\b(forward|send|export|leak|upload)\b.{0,50}\b(all|every|entire)\b.{0,30}\b(emails?|inbox|messages?|contacts?)\b.{0,30}\bto\b/i,
        message:
          "Bulk-forwarding a whole mailbox isn't something I'll do. I can forward specific messages you point me at.",
      },
    ],
  },

  tool: {
    /**
     * Tools that change the world outside this app and cannot be undone by the
     * user clicking "back". These require explicit human approval before they
     * run — see tool.guard.ts.
     */
    requiresApproval: ["send_mail", "reply_to_mail", "cancel_meeting"] as string[],

    /**
     * Per-turn caps. A model stuck in a loop should hit a wall long before it
     * hits the user's Gmail sending quota.
     */
    maxWritesPerTurn: 3,
    maxRecipientsPerMessage: 10,

    /**
     * Addresses the agent may never mail, whatever the user asks.
     * Supports exact addresses and "@domain.com" suffixes.
     */
    recipientDenyList: [] as string[],
  },

  output: {
    /**
     * Fragments that mean our own system prompt has leaked into an answer.
     * If any appears, the answer is replaced rather than patched: a partially
     * redacted system prompt is still a leaked system prompt.
     */
    leakMarkers: [
      "You are CortexOne Workspace",
      "You are CortexOne, a sharp and direct",
      "Working with tools:",
      "TRUST BOUNDARY",
      "UNTRUSTED CONTENT",
    ],

    /** Only these schemes may appear in a rendered link. */
    allowedLinkSchemes: ["http:", "https:", "mailto:"],
  },
} as const;

/** What every guard returns. `flags` feeds the trace and the Insights page. */
export type GuardVerdict = {
  ok: boolean;
  /** The text to use from here on. May be redacted even when ok is true. */
  value: string;
  flags: string[];
  /** Set when ok is false: the message shown to the user. */
  reason?: string;
};
