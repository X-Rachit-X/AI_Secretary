import { invokeModel } from "../gateway.js";
import { runBilled } from "../../services/credits.service.js";
import { saveBuffer } from "../../lib/storage.js";
import { renderDeck, type DeckSlide, type DeckSpec } from "../../generators/ppt.generator.js";
import type { GraphStateType } from "../state.js";

/**
 * Presentation generation: model writes the deck outline, pptxgenjs renders it.
 *
 * Same tagged-text approach as the PDF agent, for the same reason. The extra
 * wrinkle here is slide TYPES: the model picks bullets / stats / conclusion,
 * and each maps to a different layout function in the generator.
 */

const PROMPT = `Create a professional presentation on the topic below.

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
  const blocks = content.split(/^SLIDE:/m).slice(1);

  for (const block of blocks) {
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

export async function pptAgent(state: GraphStateType) {
  return runBilled(state.userId, "ppt", async () => {
    state.onProgress?.("Outlining the deck");

    const result = await invokeModel(PROMPT + state.prompt, {
      role: "ppt",
      meter: state.meter,
    });
    const spec = parseDeck(String(result.content ?? ""), state.prompt);

    // Refund rather than hand back an empty deck.
    if (spec.slides.length === 0) {
      throw new Error("The model output did not match the slide format.");
    }

    state.onProgress?.("Building the slides");

    const buffer = await renderDeck(spec);

    const saved = await saveBuffer({
      userId: state.userId,
      buffer,
      fileName: `${spec.title.replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "presentation"}.pptx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    return {
      response: [
        `## ${spec.title}`,
        "",
        spec.subtitle ?? "",
        "",
        `Deck ready, ${spec.slides.length + 1} slides including the cover.`,
        "",
        `[Download ${saved.name}](${saved.url})`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });
}
