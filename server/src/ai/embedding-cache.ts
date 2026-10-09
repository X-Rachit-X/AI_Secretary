import { createHash } from "node:crypto";
import type { Embeddings } from "@langchain/core/embeddings";

/**
 * Caches embeddings by content hash.
 *
 * ── The problem it solves ───────────────────────────────────────────────────
 *
 * Document Q&A builds its index per request. So asking a second question about
 * the same PDF re-embedded every chunk: for a 40-page document that is hundreds
 * of embedding calls, paid for again, to produce byte-identical vectors.
 *
 * ── Why a content hash is the right key ─────────────────────────────────────
 *
 * An embedding is a pure function of (text, model). Same text and same model
 * always give the same vector, so unlike a chat completion there is no
 * correctness question at all — caching cannot change an answer, only skip
 * work. That makes it the safest thing in the whole system to cache, and the
 * reason this cache has no TTL based on freshness.
 *
 * The model id IS in the key, because switching embedding models produces
 * vectors in a different space. Mixing them would silently wreck retrieval:
 * cosine similarity between two different spaces is meaningless, and nothing
 * would error — you would just get bad chunks.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * In-process and bounded. It survives for the life of the process, which is
 * what makes the follow-up question free. Lost on restart, which is fine: the
 * worst case is the behaviour we had before.
 */

const MAX_ENTRIES = 5000;

type Stats = { hits: number; misses: number; evictions: number };

const vectors = new Map<string, number[]>();
const stats: Stats = { hits: 0, misses: 0, evictions: 0 };

function keyFor(model: string, text: string) {
  return `${model}|${createHash("sha256").update(text).digest("hex")}`;
}

function remember(key: string, vector: number[]) {
  // Map iterates in insertion order, so the first key is the oldest.
  if (vectors.size >= MAX_ENTRIES) {
    const oldest = vectors.keys().next().value;
    if (oldest) {
      vectors.delete(oldest);
      stats.evictions += 1;
    }
  }

  vectors.set(key, vector);
}

/**
 * Wrap an Embeddings instance so repeated text is embedded once.
 *
 * Returns the same `Embeddings` shape, so callers — the vector store, the
 * docqa agent — are unchanged and unaware.
 */
export function withEmbeddingCache(
  embeddings: Embeddings,
  modelId: string,
): Embeddings {
  return {
    ...embeddings,

    /**
     * Only the chunks that are actually new get sent to the provider.
     *
     * The order of the returned array has to match the order of the input, so
     * misses are collected with their original positions and written back into
     * the right slots.
     */
    async embedDocuments(texts: string[]): Promise<number[][]> {
      const out: number[][] = new Array(texts.length);
      const missingTexts: string[] = [];
      const missingAt: number[] = [];

      texts.forEach((text, index) => {
        const key = keyFor(modelId, text);
        const hit = vectors.get(key);

        if (hit) {
          out[index] = hit;
          stats.hits += 1;
        } else {
          missingTexts.push(text);
          missingAt.push(index);
          stats.misses += 1;
        }
      });

      if (missingTexts.length > 0) {
        // One batched call for everything missing, not one per chunk.
        const fresh = await embeddings.embedDocuments(missingTexts);

        fresh.forEach((vector, i) => {
          const index = missingAt[i];
          out[index] = vector;
          remember(keyFor(modelId, missingTexts[i]), vector);
        });
      }

      return out;
    },

    async embedQuery(text: string): Promise<number[]> {
      const key = keyFor(modelId, `query:${text}`);
      const hit = vectors.get(key);

      if (hit) {
        stats.hits += 1;
        return hit;
      }

      stats.misses += 1;

      // embedQuery, not embedDocuments: some providers use a different
      // instruction for queries than for the passages being searched, so the
      // two must never share a cache entry. Hence the "query:" prefix.
      const vector = await embeddings.embedQuery(text);
      remember(key, vector);
      return vector;
    },
  } as Embeddings;
}

/** Surfaced on the Insights page next to the model cache. */
export function embeddingCacheStats() {
  const lookups = stats.hits + stats.misses;

  return {
    entries: vectors.size,
    maxEntries: MAX_ENTRIES,
    hits: stats.hits,
    misses: stats.misses,
    evictions: stats.evictions,
    hitRate: lookups === 0 ? null : stats.hits / lookups,
  };
}
