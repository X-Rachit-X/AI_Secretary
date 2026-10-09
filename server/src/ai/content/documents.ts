import { invokeModel } from "../gateway.js";
import type { UsageMeter } from "../gateway.js";
import { saveBuffer, type SavedFile } from "../../lib/storage.js";
import { renderPdf, type PdfDocumentSpec } from "../../generators/pdf.generator.js";
import {
  renderDeck,
  type DeckSlide,
  type DeckSpec,
} from "../../generators/ppt.generator.js";

/**
 * PDF and slide-deck generation, as plain functions.
 *
 * Both follow the same two-step shape: ask a model for a tagged outline, then
 * render it with pdfkit / pptxgenjs. Neither makes a decision, which is why
 * they are tools rather than agents.
 *
 * Tagged text rather than JSON on purpose. Model JSON fails a dozen ways — a
 * trailing comma, a smart quote, a stray ```json fence — and each failure
 * wastes a paid call. A line format DEGRADES: an unrecognised line is skipped
 * and the rest still renders. The eval suite covers each malformed case.
 */

export type GenerationContext = {
  userId: string;
  meter?: UsageMeter;
  /** Research to ground the document in, when a search ran first. */
  research?: string;
};

/**
 * Research is appended rather than interpolated into the middle of the prompt
 * so the format spec above it stays the last thing the model read before the
 * topic — which measurably improves format adherence.
 */
function researchBlock(research?: string) {
  if (!research?.trim()) return "";

  return `

Use these web search results as the source of fact. They are more recent than
your training data. Prefer them, and do not invent figures that are not in them.

${research}
`;
}

// ── PDF ─────────────────────────────────────────────────────────────────────

const PDF_PROMPT = `Write a professional document on the topic below.

Return ONLY this format. No Markdown, no asterisks, no code fences.

TITLE: <document title>
SUBTITLE: <one line description>

SECTION: Introduction
P: <a full paragraph>
P: <another paragraph>

SECTION: <next section heading>
P: <a paragraph>
B: <a bullet point>
B: <another bullet point>

SECTION: Conclusion
P: <a closing paragraph>

Rules:
- 4 to 6 SECTION blocks including an introduction and a conclusion.
- P: lines are full paragraphs, 2 to 4 sentences each.
- B: lines are short bullet points. Use them where a list genuinely helps.
- Every line must start with TITLE:, SUBTITLE:, SECTION:, P: or B:.

Topic: `;

/** Any line without a known tag is ignored, which is what makes it degrade. */
function parseOutline(content: string, fallbackTitle: string): PdfDocumentSpec {
  const spec: PdfDocumentSpec = {
    title: fallbackTitle.slice(0, 120),
    sections: [],
  };

  let current: PdfDocumentSpec["sections"][number] | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("TITLE:")) {
      spec.title = line.slice(6).trim() || spec.title;
    } else if (line.startsWith("SUBTITLE:")) {
      spec.subtitle = line.slice(9).trim();
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
      current.bullets?.push(line.slice(2).trim());
    }
  }

  return spec;
}

export async function makePdf(
  topic: string,
  context: GenerationContext,
): Promise<{ file: SavedFile; title: string; sections: number }> {
  const result = await invokeModel(
    PDF_PROMPT + topic + researchBlock(context.research),
    { role: "pdf", meter: context.meter },
  );

  const spec = parseOutline(String(result.content ?? ""), topic);

  // Throwing refunds the credits rather than charging for an empty PDF.
  if (spec.sections.length === 0) {
    throw new Error("The model did not return any usable sections.");
  }

  const buffer = await renderPdf(spec);

  const file = await saveBuffer({
    userId: context.userId,
    buffer,
    fileName: `${safeName(spec.title) || "document"}.pdf`,
    mimeType: "application/pdf",
  });

  return { file, title: spec.title, sections: spec.sections.length };
}

// ── Slide deck ──────────────────────────────────────────────────────────────

const DECK_PROMPT = `Create a professional presentation on the topic below.

Return ONLY this format. No Markdown, no explanation, no code fences.

TITLE: <deck title>
SUBTITLE: <one line tagline>

SLIDE:
Type: bullets
Title: <slide title>
- <point one>
- <point two>
- <point three>
- <point four>

SLIDE:
Type: stats
Title: <slide title>
- <Label> | <Value>
- <Label> | <Value>
- <Label> | <Value>

SLIDE:
Type: conclusion
Title: Conclusion
- <takeaway one>
- <takeaway two>
- <takeaway three>

Rules:
- Exactly 8 SLIDE blocks after the title.
- Most slides are "bullets" with 4 to 6 points, each one short.
- Use "stats" exactly once, with 3 or 4 "Label | Value" lines.
- The last slide is "conclusion" with 3 or 4 takeaways.

Topic: `;

function parseDeck(content: string, fallbackTitle: string): DeckSpec {
  const spec: DeckSpec = { title: fallbackTitle.slice(0, 100), slides: [] };

  const titleMatch = content.match(/^TITLE:\s*(.+)$/m);
  if (titleMatch) spec.title = titleMatch[1].trim();

  const subtitleMatch = content.match(/^SUBTITLE:\s*(.+)$/m);
  if (subtitleMatch) spec.subtitle = subtitleMatch[1].trim();

  // Everything before the first SLIDE: is the header, so drop block 0.
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

    if (type === "stats") {
      const stats = items.map((item) => {
        const [label, value] = item.split("|").map((part) => part.trim());
        return { label: label ?? item, value: value ?? "" };
      });

      spec.slides.push({ type: "stats", title, stats } satisfies DeckSlide);
    } else if (type === "conclusion") {
      spec.slides.push({ type: "conclusion", title, items } satisfies DeckSlide);
    } else {
      spec.slides.push({ type: "bullets", title, items } satisfies DeckSlide);
    }
  }

  return spec;
}

export async function makeDeck(
  topic: string,
  context: GenerationContext,
): Promise<{ file: SavedFile; title: string; slides: number }> {
  const result = await invokeModel(
    DECK_PROMPT + topic + researchBlock(context.research),
    { role: "ppt", meter: context.meter },
  );

  const spec = parseDeck(String(result.content ?? ""), topic);

  if (spec.slides.length === 0) {
    throw new Error("The model output did not match the slide format.");
  }

  const buffer = await renderDeck(spec);

  const file = await saveBuffer({
    userId: context.userId,
    buffer,
    fileName: `${safeName(spec.title) || "presentation"}.pptx`,
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });

  // +1 for the cover slide the generator adds.
  return { file, title: spec.title, slides: spec.slides.length + 1 };
}

/** Strip anything that would be awkward in a filename. */
function safeName(title: string) {
  return title
    .replace(/[^\w\s-]/g, "")
    .trim()
    .slice(0, 60);
}

/** Exported for the eval suite, which asserts the degradation behaviour. */
export { parseOutline, parseDeck };
