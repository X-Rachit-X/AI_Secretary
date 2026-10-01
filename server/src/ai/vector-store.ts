import type { Embeddings } from "@langchain/core/embeddings";

/**
 * A minimal in-memory vector store: embed, then rank by cosine similarity.
 *
 * LangChain v1 no longer ships `MemoryVectorStore`, and reaching for Qdrant or
 * pgvector to answer one question about one uploaded PDF would mean running a
 * database for data that is thrown away seconds later.
 *
 * Retrieval is the whole of RAG that is worth understanding, and it is this:
 *
 *   1. Turn every chunk into a vector (the embedding model does this).
 *   2. Turn the question into a vector the same way.
 *   3. Score each chunk by how closely its vector points in the same
 *      direction as the question's.
 *   4. Hand the top few chunks to the model as context.
 *
 * Cosine similarity is step 3: the dot product of two vectors divided by their
 * magnitudes, which is the cosine of the angle between them. 1 means identical
 * direction, 0 means unrelated. Dividing out the magnitudes is what makes a
 * long chunk and a short chunk comparable.
 *
 * This is a linear scan, so it is O(n) per query. For the few hundred chunks a
 * document produces that is microseconds. A real corpus of millions of vectors
 * is exactly when you reach for a vector database and its approximate index.
 */

export type VectorDocument = {
  pageContent: string;
  metadata?: Record<string, unknown>;
};

type Entry = VectorDocument & { vector: number[] };

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    magnitudeA += a[index] * a[index];
    magnitudeB += b[index] * b[index];
  }

  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);

  // A zero vector has no direction, so there is no angle to measure.
  return denominator === 0 ? 0 : dot / denominator;
}

export class MemoryVectorStore {
  private entries: Entry[] = [];

  constructor(private readonly embeddings: Embeddings) {}

  /**
   * Embed and store documents.
   *
   * `embedDocuments` takes the whole batch in one call on purpose: one request
   * for 200 chunks is dramatically faster, and cheaper, than 200 requests.
   */
  async addDocuments(documents: VectorDocument[]) {
    if (documents.length === 0) return;

    const vectors = await this.embeddings.embedDocuments(
      documents.map((document) => document.pageContent),
    );

    documents.forEach((document, index) => {
      this.entries.push({ ...document, vector: vectors[index] });
    });
  }

  /** The `k` documents whose vectors point most like the query's. */
  async similaritySearch(query: string, k = 4): Promise<VectorDocument[]> {
    if (this.entries.length === 0) return [];

    // embedQuery, not embedDocuments: some providers use a different
    // instruction for queries than for the passages being searched.
    const queryVector = await this.embeddings.embedQuery(query);

    return this.entries
      .map((entry) => ({
        entry,
        score: cosineSimilarity(queryVector, entry.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ entry }) => ({
        pageContent: entry.pageContent,
        metadata: entry.metadata,
      }));
  }

  get size() {
    return this.entries.length;
  }

  /** Mirrors the LangChain vector store API, so swapping one in is a one-liner. */
  static async fromDocuments(
    documents: VectorDocument[],
    embeddings: Embeddings,
  ) {
    const store = new MemoryVectorStore(embeddings);
    await store.addDocuments(documents);
    return store;
  }
}
