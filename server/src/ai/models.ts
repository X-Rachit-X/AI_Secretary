import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGroq } from "@langchain/groq";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { env, type LlmProvider } from "../env.js";
import { AppError } from "../lib/errors.js";

/**
 * The only place a model is constructed.
 *
 * Agents ask for a model by ROLE ("router", "chat", "vision"), never by
 * provider name. Swapping providers is then a one-line .env change, and a role
 * that needs something special (deterministic routing, a vision-capable model)
 * can be tuned without touching the agent.
 *
 * Models are cached per role and provider: constructing a client re-reads
 * credentials and sets up an HTTP agent, which is wasted work on every turn.
 *
 * Agents do NOT call `getModel()` directly — they go through
 * `invokeModel()` in gateway.ts, which adds retries, timeouts, fallback and
 * cost accounting on top. This file only decides *which client*.
 */

export type ModelRole =
  | "router"
  | "chat"
  | "search"
  | "coding"
  | "pdf"
  | "ppt"
  | "image"
  | "vision"
  | "docqa"
  | "workspace";

type RoleConfig = { temperature: number; maxTokens?: number };

/**
 * Temperature per role. Zero where the output is parsed by code (routing,
 * slide format, file blocks); warmer where the output is prose for a human.
 */
const ROLE_CONFIG: Record<ModelRole, RoleConfig> = {
  router: { temperature: 0, maxTokens: 16 },
  chat: { temperature: 0.7 },
  search: { temperature: 0.3 },
  coding: { temperature: 0.2, maxTokens: 4000 },
  pdf: { temperature: 0.5, maxTokens: 3000 },
  ppt: { temperature: 0.5, maxTokens: 2500 },
  image: { temperature: 0.8, maxTokens: 500 },
  vision: { temperature: 0.3 },
  docqa: { temperature: 0.1 },
  workspace: { temperature: 0.2 },
};

function missingKey(name: string) {
  return new AppError(
    500,
    "Model not configured",
    `${name} is not set. Add it to server/.env, or change LLM_PROVIDER.`,
  );
}

/**
 * The concrete model id a provider will be asked for. Used for pricing.
 * Role is accepted for future per-role model overrides; today every role on a
 * provider uses the same model.
 */
export function modelIdFor(_role: ModelRole, fallback = false): string {
  const provider = fallback ? env.llmFallbackProvider : env.llmProvider;

  switch (provider) {
    case "openai":
      return env.openai.chatModel;
    case "openrouter":
      return env.openrouter.chatModel;
    case "groq":
      return env.groq.chatModel;
    case "anthropic":
      return env.anthropic.chatModel;
    case "google":
      return env.google.chatModel;
    default:
      return "unknown";
  }
}

function build(provider: LlmProvider, role: ModelRole): BaseChatModel {
  const config = ROLE_CONFIG[role];

  switch (provider) {
    case "openai":
      if (!env.openai.apiKey) throw missingKey("OPENAI_API_KEY");
      return new ChatOpenAI({
        apiKey: env.openai.apiKey,
        model: env.openai.chatModel,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });

    /**
     * OpenRouter is a hosted LLM gateway: one key and one OpenAI-compatible
     * endpoint in front of hundreds of models, with its own failover. The
     * OpenAI client speaks to it unchanged — only the base URL differs.
     *
     * Use this when you want provider routing managed for you. The in-process
     * gateway in gateway.ts still applies on top, so you keep the caching,
     * cost accounting and per-run usage either way.
     */
    case "openrouter":
      if (!env.openrouter.apiKey) throw missingKey("OPENROUTER_API_KEY");
      return new ChatOpenAI({
        apiKey: env.openrouter.apiKey,
        model: env.openrouter.chatModel,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        configuration: {
          baseURL: "https://openrouter.ai/api/v1",
          defaultHeaders: {
            // OpenRouter uses these for its public model-usage leaderboard.
            "HTTP-Referer": env.appUrl,
            "X-Title": "AI Secretary",
          },
        },
      });

    case "groq":
      if (!env.groq.apiKey) throw missingKey("GROQ_API_KEY");
      return new ChatGroq({
        apiKey: env.groq.apiKey,
        model: env.groq.chatModel,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });

    case "anthropic":
      if (!env.anthropic.apiKey) throw missingKey("ANTHROPIC_API_KEY");
      return new ChatAnthropic({
        apiKey: env.anthropic.apiKey,
        model: env.anthropic.chatModel,
        temperature: config.temperature,
        maxTokens: config.maxTokens ?? 4096,
      });

    case "google":
    default:
      if (!env.google.apiKey) throw missingKey("GOOGLE_API_KEY");
      return new ChatGoogleGenerativeAI({
        apiKey: env.google.apiKey,
        model: env.google.chatModel,
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
      });
  }
}

const cache = new Map<string, BaseChatModel>();

function cached(provider: LlmProvider, role: ModelRole): BaseChatModel {
  const key = `${provider}:${role}`;
  const hit = cache.get(key);

  if (hit) return hit;

  const model = build(provider, role);
  cache.set(key, model);
  return model;
}

export function getModel(role: ModelRole): BaseChatModel {
  return cached(env.llmProvider, role);
}

/**
 * The secondary provider, used by the gateway when the primary keeps failing.
 *
 * Returns null when no fallback is configured, or when it is the same as the
 * primary — retrying the identical client would just repeat the failure.
 */
export function getFallbackModel(role: ModelRole): BaseChatModel | null {
  const provider = env.llmFallbackProvider;

  if (!provider || provider === env.llmProvider) return null;

  try {
    return cached(provider, role);
  } catch {
    // A misconfigured fallback must never break the primary path.
    return null;
  }
}

/**
 * Embeddings for document Q&A.
 *
 * Always Google: it is the one provider in this list with a free embedding
 * tier, and embeddings are cheap enough that mixing providers (Gemini for
 * vectors, anything you like for chat) is a reasonable default.
 */
let embeddingsCache: GoogleGenerativeAIEmbeddings | null = null;

export function getEmbeddings() {
  if (!env.google.apiKey) throw missingKey("GOOGLE_API_KEY");

  if (!embeddingsCache) {
    embeddingsCache = new GoogleGenerativeAIEmbeddings({
      apiKey: env.google.apiKey,
      model: env.google.embeddingModel,
    });
  }

  return embeddingsCache;
}

/**
 * Not every provider can read images. The vision agent calls this first so the
 * user gets a clear message instead of a confusing provider error.
 */
export function providerSupportsVision() {
  return ["google", "openai", "anthropic", "openrouter"].includes(
    env.llmProvider,
  );
}
