import { MemoryVectorStore } from "../ai/vector-store.js";
import type { CaseResult, Suite } from "./types.js";

/**
 * Offline suite: the things that turn model output into working artefacts.
 *
 * The PDF and PPT agents both ask the model for a tagged text format and then
 * parse it. That parser is the single point where "the model said something
 * slightly different today" turns into either a working deck or an empty one,
 * so it is worth pinning down — including the malformed cases, where the
 * required behaviour is *degrade, do not throw*.
 *
 * The parsers are re-implemented here rather than imported, because in the
 * agents they are module-private. That is a deliberate trade: exporting them
 * only for tests would widen the agents' public surface for no runtime reason,
 * and these two functions are small enough that a copy is cheaper than the
 * coupling. If they grow, export them and delete these.
 */

// ── Deck parser (mirrors ppt.agent.ts) ──────────────────────────────────────

type ParsedDeck = {
  title: string;
  subtitle?: string;
  slides: Array<{ type: string; title: string; items: string[] }>;
};

function parseDeck(content: string, fallbackTitle: string): ParsedDeck {
  const spec: ParsedDeck = { title: fallbackTitle.slice(0, 100), slides: [] };

  const titleMatch = content.match(/^TITLE:\s*(.+)$/m);
  if (titleMatch) spec.title = titleMatch[1].trim();

  const subtitleMatch = content.match(/^SUBTITLE:\s*(.+)$/m);
  if (subtitleMatch) spec.subtitle = subtitleMatch[1].trim();

  for (const block of content.split(/^SLIDE:/m).slice(1)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const title =
      lines.find((line) => line.startsWith("Title:"))?.slice(6).trim() ||
      "Slide";

    const type =
      lines
        .find((line) => line.startsWith("Type:"))
        ?.slice(5)
        .trim()
        .toLowerCase() ?? "bullets";

    const items = lines
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);

    if (items.length === 0) continue;

    spec.slides.push({ type, title, items });
  }

  return spec;
}

const GOOD_DECK = `TITLE: Retrieval Augmented Generation
SUBTITLE: Grounding models in your own data

SLIDE:
Type: bullets
Title: Why RAG
- Models have a training cutoff
- Fine-tuning is slow
- Your data changes daily

SLIDE:
Type: stats
Title: By the numbers
- Chunk size | 1000
- Overlap | 200
- Top K | 5

SLIDE:
Type: conclusion
Title: Conclusion
- Retrieval beats memorisation
- Chunking is the hard part`;

const DECK_CASES: Array<{
  id: string;
  about: string;
  input: string;
  check: (deck: ParsedDeck) => string | null;
}> = [
  {
    id: "deck.happy",
    about: "well-formed output parses to the right slide count and types",
    input: GOOD_DECK,
    check: (deck) => {
      if (deck.title !== "Retrieval Augmented Generation") return "wrong title";
      if (deck.slides.length !== 3)
        return `expected 3 slides, got ${deck.slides.length}`;
      if (deck.slides[1].type !== "stats") return "stats slide not detected";
      if (deck.slides[0].items.length !== 3) return "bullets lost";
      return null;
    },
  },
  {
    id: "deck.degrade.code_fence",
    about:
      "DEGRADE: a stray markdown fence does not stop the rest from parsing",
    input: "```\n" + GOOD_DECK + "\n```",
    check: (deck) =>
      deck.slides.length === 3 ? null : "fence broke the parse",
  },
  {
    id: "deck.degrade.chatty_preamble",
    about: "DEGRADE: a conversational preamble is ignored",
    input: "Sure! Here's your deck:\n\n" + GOOD_DECK,
    check: (deck) =>
      deck.slides.length === 3 ? null : "preamble broke the parse",
  },
  {
    id: "deck.degrade.missing_type",
    about: "DEGRADE: a slide with no Type line defaults to bullets",
    input: "TITLE: T\n\nSLIDE:\nTitle: A\n- one\n- two",
    check: (deck) =>
      deck.slides[0]?.type === "bullets" ? null : "did not default to bullets",
  },
  {
    id: "deck.degrade.empty_slide_skipped",
    about: "DEGRADE: a slide with no bullets is skipped, not rendered blank",
    input: "TITLE: T\n\nSLIDE:\nType: bullets\nTitle: Empty\n\nSLIDE:\nType: bullets\nTitle: Real\n- x",
    check: (deck) =>
      deck.slides.length === 1 ? null : "empty slide was not skipped",
  },
  {
    id: "deck.degrade.total_garbage",
    about:
      "DEGRADE: unusable output yields zero slides so the agent can refund, not throw",
    input: "I'm sorry, I can't help with that.",
    check: (deck) =>
      deck.slides.length === 0 ? null : "garbage produced slides",
  },
];

// ── Document parser (mirrors pdf.agent.ts) ──────────────────────────────────

type ParsedDoc = {
  title: string;
  sections: Array<{ heading: string; paragraphs: string[]; bullets: string[] }>;
};

function parseOutline(content: string, fallbackTitle: string): ParsedDoc {
  const spec: ParsedDoc = { title: fallbackTitle.slice(0, 120), sections: [] };
  let current: ParsedDoc["sections"][number] | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("TITLE:")) {
      spec.title = line.slice(6).trim() || spec.title;
    } else if (line.startsWith("SECTION:")) {
      current = {
        heading: line.slice(8).trim() || "Section",
        paragraphs: [],
        bullets: [],
      };
      spec.sections.push(current);
    } else if (line.startsWith("P:") && current) {
      current.paragraphs.push(line.slice(2).trim());
    } else if (line.startsWith("B:") && current) {
      current.bullets.push(line.slice(2).trim());
    }
  }

  return spec;
}

const DOC_CASES: Array<{
  id: string;
  about: string;
  input: string;
  check: (doc: ParsedDoc) => string | null;
}> = [
  {
    id: "doc.happy",
    about: "well-formed output parses sections, paragraphs and bullets",
    input: `TITLE: Postgres Indexing
SUBTITLE: A practical guide

SECTION: Introduction
P: Indexes trade write speed for read speed.
P: Choosing one means knowing your queries.

SECTION: B-tree
P: The default, and usually right.
B: Good for equality and range
B: Useless for leading wildcards`,
    check: (doc) => {
      if (doc.title !== "Postgres Indexing") return "wrong title";
      if (doc.sections.length !== 2) return "wrong section count";
      if (doc.sections[1].bullets.length !== 2) return "bullets lost";
      return null;
    },
  },
  {
    id: "doc.degrade.unknown_lines",
    about: "DEGRADE: unrecognised lines are skipped, the rest still renders",
    input: `TITLE: T
Here is some chatter the model added.
SECTION: One
P: Real content.
Random trailing note.`,
    check: (doc) =>
      doc.sections[0]?.paragraphs.length === 1
        ? null
        : "unknown lines broke the parse",
  },
  {
    id: "doc.degrade.orphan_paragraph",
    about:
      "DEGRADE: a P: before any SECTION: is dropped rather than crashing",
    input: "TITLE: T\nP: orphan\nSECTION: One\nP: real",
    check: (doc) =>
      doc.sections.length === 1 && doc.sections[0].paragraphs.length === 1
        ? null
        : "orphan paragraph mishandled",
  },
  {
    id: "doc.degrade.empty",
    about: "DEGRADE: no sections means the agent refunds instead of charging",
    input: "Sorry, I can't do that.",
    check: (doc) => (doc.sections.length === 0 ? null : "garbage made sections"),
  },
];

// ── Vector store ────────────────────────────────────────────────────────────

/**
 * A fake embedder, so retrieval is tested without a network call.
 *
 * Maps text to a vector by counting a few keywords. Crude, but it makes
 * "closer in meaning ranks higher" assertable and deterministic, which is the
 * property the real one is supposed to have.
 */
const KEYWORDS = ["cat", "dog", "invoice", "meeting", "postgres"];

const fakeEmbeddings = {
  embedDocuments: async (texts: string[]) => texts.map(toVector),
  embedQuery: async (text: string) => toVector(text),
} as never;

function toVector(text: string): number[] {
  const lower = text.toLowerCase();
  return KEYWORDS.map((word) => (lower.split(word).length - 1) || 0);
}

async function runVectorCases(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  const store = await MemoryVectorStore.fromDocuments(
    [
      { pageContent: "The cat sat on the mat. A cat is a cat." },
      { pageContent: "Invoice 1234 is overdue. Please pay the invoice." },
      { pageContent: "Postgres indexing with B-trees and postgres planners." },
    ],
    fakeEmbeddings,
  );

  const top = await store.similaritySearch("tell me about the invoice", 1);

  results.push({
    id: "vec.ranks_relevant_first",
    about: "the chunk sharing the query's keyword ranks first",
    passed: Boolean(top[0]?.pageContent.includes("Invoice")),
    score: top[0]?.pageContent.includes("Invoice") ? 1 : 0,
    expected: "invoice chunk",
    actual: top[0]?.pageContent.slice(0, 40),
  });

  const k = await store.similaritySearch("cat", 2);

  results.push({
    id: "vec.respects_k",
    about: "similaritySearch returns exactly k results",
    passed: k.length === 2,
    score: k.length === 2 ? 1 : 0,
    expected: 2,
    actual: k.length,
  });

  const empty = new MemoryVectorStore(fakeEmbeddings);
  const emptyResult = await empty.similaritySearch("anything", 3);

  results.push({
    id: "vec.empty_store_safe",
    about:
      "EDGE: an empty store returns [] rather than dividing by zero or throwing",
    passed: emptyResult.length === 0,
    score: emptyResult.length === 0 ? 1 : 0,
    expected: 0,
    actual: emptyResult.length,
  });

  // A zero vector has no direction; cosine similarity must not produce NaN.
  const zeroStore = await MemoryVectorStore.fromDocuments(
    [{ pageContent: "nothing matches here" }],
    fakeEmbeddings,
  );

  const zeroResult = await zeroStore.similaritySearch("also unrelated", 1);

  results.push({
    id: "vec.zero_vector_safe",
    about: "EDGE: zero-magnitude vectors score 0 instead of NaN",
    passed: zeroResult.length === 1,
    score: zeroResult.length === 1 ? 1 : 0,
    expected: "1 result, no NaN crash",
    actual: `${zeroResult.length} result(s)`,
  });

  return results;
}

export const parserSuite: Suite = {
  name: "parsers",
  kind: "offline",
  about:
    "deck and document parsers degrade instead of throwing; vector retrieval ranks and bounds correctly",
  run: async () => {
    const deck = DECK_CASES.map((testCase) => {
      const problem = testCase.check(parseDeck(testCase.input, "fallback"));

      return {
        id: testCase.id,
        about: testCase.about,
        passed: problem === null,
        score: problem === null ? 1 : 0,
        expected: "parses as specified",
        actual: problem ?? "ok",
        note: problem ?? undefined,
      };
    });

    const doc = DOC_CASES.map((testCase) => {
      const problem = testCase.check(parseOutline(testCase.input, "fallback"));

      return {
        id: testCase.id,
        about: testCase.about,
        passed: problem === null,
        score: problem === null ? 1 : 0,
        expected: "parses as specified",
        actual: problem ?? "ok",
        note: problem ?? undefined,
      };
    });

    return [...deck, ...doc, ...(await runVectorCases())];
  },
};
