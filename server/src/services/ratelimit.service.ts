import { AppError } from "../lib/errors.js";

/**
 * Per-user, per-agent rate limiting.
 *
 * The original project used Redis so counters were shared across service
 * replicas. This app is a single process, so an in-memory Map does the same
 * job with no extra infrastructure. If you ever run more than one instance,
 * replace the Map with Redis INCR + EXPIRE; the exported function signature
 * stays identical.
 *
 * Fixed window: the counter for a user+agent resets WINDOW_MS after the first
 * request in that window.
 */

const WINDOW_MS = 60_000;

/** Maximum runs per minute, per user. Expensive agents get smaller numbers. */
const LIMITS: Record<string, number> = {
  chat: 20,
  search: 8,
  coding: 5,
  pdf: 5,
  ppt: 5,
  image: 3,
  vision: 8,
  docqa: 8,
  workspace: 15,
};

type Counter = { count: number; resetAt: number };

const counters = new Map<string, Counter>();

// Without this, a long-running process accumulates one Map entry per
// user+agent pair forever.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, counter] of counters) {
    if (counter.resetAt <= now) counters.delete(key);
  }
}, WINDOW_MS);

// Do not hold the event loop open just for the sweep.
sweep.unref?.();

export async function checkRateLimit(userId: string, agent: string) {
  const limit = LIMITS[agent] ?? LIMITS.chat;
  const key = `${userId}:${agent}`;
  const now = Date.now();

  const existing = counters.get(key);

  if (!existing || existing.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { remaining: limit - 1, limit };
  }

  existing.count += 1;

  if (existing.count > limit) {
    const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
    throw AppError.rateLimited(agent, limit, retryAfter);
  }

  return { remaining: limit - existing.count, limit };
}
