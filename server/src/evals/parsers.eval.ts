import { MemoryVectorStore } from "../ai/vector-store.js";
import { parseDeck, parseOutline } from "../ai/content/documents.js";
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
 * The parsers are imported from ai/content/documents.ts rather than copied.
 * They used to be private to the agent files, so the tests held duplicates;
 * now that the content capabilities are plain exported functions, the tests
 * check the real thing — which is the point of having moved them.
 */

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
  check: (deck: ReturnType<typeof parseDeck>) => string | null;
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

      // DeckSlide is a discriminated union, so `items` has to be narrowed —
      // which is exactly the kind of mistake importing the real type catches.
      const first = deck.slides[0];
      if (first.type === "stats") return "first slide should be bullets";
      if (first.items.length !== 3) return "bullets lost";

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

const DOC_CASES: Array<{
  id: string;
  about: string;
  input: string;
  check: (doc: ReturnType<typeof parseOutline>) => string | null;
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
      // `bullets` is optional on PdfDocumentSpec: a section may have none.
      if ((doc.sections[1].bullets ?? []).length !== 2) return "bullets lost";
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
