import { createHash } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import {
  getModel,
  getFallbackModel,
  modelIdFor,
  type ModelRole,
} from "./models.js";
import { estimateCost } from "./pricing.js";
import { env } from "../env.js";

/**
 * The LLM gateway: one function every model call goes through.
 *
 * Calling `model.invoke()` directly from nine different agents means nine
 * copies of the retry logic, nine places that forget the timeout, and no way
 * to answer "what did today cost?". This file is that logic, once.
 *
 * What it adds, in the order it applies:
 *
 *   1. CACHE     deterministic roles (temperature 0) answer the same question
 *                the same way, so the router never pays twice for "what's on
 *                my calendar today"
 *   2. TIMEOUT   a provider that hangs must not hold a request, and the user's
 *                credits, open forever
 *   3. RETRY     429 and 5xx are transient; exponential backoff with jitter
 *   4. FALLBACK  if the primary provider is still failing, try the secondary
 *                one if LLM_FALLBACK_PROVIDER is configured
 *   5. ACCOUNT   token counts and estimated cost, collected per run
 *
 * The usage numbers flow into the Trace row for the run, which is what makes
 * the Insights page possible.
 *
 * This is an in-process gateway. If you would rather use a hosted one
 * (OpenRouter, LiteLLM, Portkey), set LLM_PROVIDER=openrouter — models.ts
 * points the OpenAI client at OpenRouter's base URL and everything here still
 * applies on top.
 */

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelCalls: number;
  cacheHits: number;
  retries: number;
  fallbacks: number;
};

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    cacheHits: 0,
    retries: 0,
    fallbacks: 0,
  };
}

/**
 * A per-run usage collector.
 *
 * Passed down through GraphState so every model call in a run, including the
 * ones inside the ReAct loop, adds to the same total.
 */
export class UsageMeter {
  readonly usage: Usage = emptyUsage();

  add(partial: Partial<Usage>) {
    for (const [key, value] of Object.entries(partial)) {
      if (typeof value === "number") {
        this.usage[key as keyof Usage] += value;
      }
    }
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────

/**
 * Only roles that run at temperature 0 are cacheable. Caching a creative role
 * would make the assistant repeat itself verbatim, which reads as broken.
 */
const CACHEABLE_ROLES: ModelRole[] = ["router"];

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

type CacheEntry = { text: string; expiresAt: number };

const cache = new Map<string, CacheEntry>();

/**
 * Hit/miss/eviction counters, surfaced on the Insights page.
 *
 * A cache with no hit rate is a cache nobody can tune: you cannot tell a
 * working cache from a cache that never hits, and both look identical from
 * the outside.
 */
const cacheStats_ = { hits: 0, misses: 0, evictions: 0 };

function cacheKey(role: ModelRole, messages: BaseMessage[] | string) {
  const payload =
    typeof messages === "string"
      ? messages
      : messages.map((m) => `${m.getType()}:${String(m.content)}`).join("\u0000");

  /**
   * The key identifies everything that can change the answer, not just the
   * input: role, provider and model id.
   *
   * "temperature is 0" is NOT on its own a sufficient reason to cache. A
   * deterministic model is only deterministic for a FIXED model — switch
   * provider or bump the model id and the same prompt can legitimately produce
   * a different answer. Leaving those out of the key is safe today only
   * because this cache is in-process and provider config cannot change without
   * a restart (which empties it). Including them makes that an explicit
   * guarantee rather than a lucky accident, and is what makes it safe to move
   * this cache to Redis later.
   *
   * Deliberately NOT in the key: the user id. Cacheable roles return a bounded
   * label from a fixed vocabulary (the router returns one agent name), never
   * user content, so sharing a hit between users leaks nothing. Any role that
   * returned user-specific text would have to be keyed per user — which is
   * exactly why CACHEABLE_ROLES is a short, explicit allowlist.
   */
  const fingerprint = [
    role,
    env.llmProvider,
    modelIdFor(role),
    createHash("sha256").update(payload).digest("hex"),
  ].join("|");

  return fingerprint;
}

function readCache(key: string): string | null {
  const entry = cache.get(key);

  if (!entry) {
    cacheStats_.misses += 1;
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    cacheStats_.evictions += 1;
    cacheStats_.misses += 1;
    return null;
  }

  cacheStats_.hits += 1;
  return entry.text;
}

function writeCache(key: string, text: string) {
  // Crude bound: drop the oldest insertion when full. A Map iterates in
  // insertion order, so the first key is the oldest.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
      cacheStats_.evictions += 1;
    }
  }

  cache.set(key, { text, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Retry ───────────────────────────────────────────────────────────────────

/**
 * Worth retrying: rate limits, provider overload, gateway errors, socket
 * resets. A 400 or a 401 means the request itself is wrong and retrying it
 * just burns time.
 */
function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const status = (error as { status?: number; code?: number })?.status;

  if (status && [408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return [
    "rate limit",
    "429",
    "overloaded",
    "timeout",
    "timed out",
    "econnreset",
    "etimedout",
    "socket hang up",
    "service unavailable",
    "internal server error",
    "fetch failed",
  ].some((needle) => message.includes(needle));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, so parallel retries do not sync up. */
function backoffMs(attempt: number) {
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base + Math.random() * 250;
}

// ── Invocation ──────────────────────────────────────────────────────────────

export type InvokeOptions = {
  role: ModelRole;
  meter?: UsageMeter;
  /** Overrides the default, which is env.llmTimeoutMs. */
  timeoutMs?: number;
  maxRetries?: number;
};

type TokenUsage = { input_tokens?: number; output_tokens?: number };

/**
 * Pull token counts out of a response.
 *
 * Every provider reports usage somewhere slightly different, and some do not
 * report it at all, so this returns zeros rather than throwing when it cannot
 * find them. A run with zero tokens on the Insights page means "the provider
 * did not say", not "it was free".
 */
function readUsage(message: AIMessage): { input: number; output: number } {
  const usage =
    (message as { usage_metadata?: TokenUsage }).usage_metadata ??
    ((message.response_metadata?.usage ??
      message.response_metadata?.tokenUsage) as TokenUsage | undefined);

  return {
    input:
      usage?.input_tokens ??
      (usage as { promptTokens?: number })?.promptTokens ??
      0,
    output:
      usage?.output_tokens ??
      (usage as { completionTokens?: number })?.completionTokens ??
      0,
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Model call timed out after ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function callOnce(
  model: BaseChatModel,
  input: BaseMessage[] | string,
  timeoutMs: number,
): Promise<AIMessage> {
  const result = await withTimeout(
    // LangChain's invoke accepts a string or a message list; the union is
    // wider than the typed overloads, so it is narrowed here once.
    model.invoke(input as never),
    timeoutMs,
  );

  return result as AIMessage;
}

/**
 * Invoke a model by role, with the whole gateway applied.
 *
 * Every agent calls this instead of `getModel(role).invoke(...)`.
 */
export async function invokeModel(
  input: BaseMessage[] | string,
  options: InvokeOptions,
): Promise<AIMessage> {
  const { role, meter } = options;
  const timeoutMs = options.timeoutMs ?? env.llmTimeoutMs;
  const maxRetries = options.maxRetries ?? env.llmMaxRetries;

  // 1. Cache.
  const cacheable = CACHEABLE_ROLES.includes(role);
  const key = cacheable ? cacheKey(role, input) : null;

  if (key) {
    const hit = readCache(key);

    if (hit !== null) {
      meter?.add({ cacheHits: 1 });
      return new AIMessage(hit);
    }
  }

  const started = Date.now();
  let lastError: unknown;

  // 2-4. Primary with retries, then the fallback provider once.
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const message = await callOnce(getModel(role), input, timeoutMs);
      const { input: inTok, output: outTok } = readUsage(message);

      meter?.add({
        modelCalls: 1,
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: estimateCost(modelIdFor(role), inTok, outTok),
        retries: attempt,
      });

      if (key) writeCache(key, String(message.content));

      return message;
    } catch (error) {
      lastError = error;

      if (!isTransient(error) || attempt === maxRetries) break;

      console.warn(
        `[gateway] ${role} attempt ${attempt + 1} failed (${(error as Error).message}), retrying`,
      );

      await sleep(backoffMs(attempt));
    }
  }

  const fallback = getFallbackModel(role);

  if (fallback) {
    console.warn(`[gateway] ${role} falling back to ${env.llmFallbackProvider}`);

    try {
      const message = await callOnce(fallback, input, timeoutMs);
      const { input: inTok, output: outTok } = readUsage(message);

      meter?.add({
        modelCalls: 1,
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: estimateCost(modelIdFor(role, true), inTok, outTok),
        fallbacks: 1,
      });

      return message;
    } catch (error) {
      lastError = error;
    }
  }

  console.error(
    `[gateway] ${role} failed after ${Date.now() - started}ms:`,
    (lastError as Error)?.message,
  );

  throw lastError;
}

/** Exposed so the Insights page can show how well the router cache is doing. */
export function cacheStats() {
  const lookups = cacheStats_.hits + cacheStats_.misses;

  return {
    entries: cache.size,
    maxEntries: CACHE_MAX_ENTRIES,
    hits: cacheStats_.hits,
    misses: cacheStats_.misses,
    evictions: cacheStats_.evictions,
    // null rather than 0 when nothing has been looked up yet: "no data" and
    // "0% hit rate" mean very different things.
    hitRate: lookups === 0 ? null : cacheStats_.hits / lookups,
    ttlMs: CACHE_TTL_MS,
    cacheableRoles: CACHEABLE_ROLES,
  };
}
