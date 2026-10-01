import { invokeModel } from "../gateway.js";
import { runBilled } from "../../services/credits.service.js";
import { saveBuffer } from "../../lib/storage.js";
import { renderPdf, type PdfDocumentSpec } from "../../generators/pdf.generator.js";
import type { GraphStateType } from "../state.js";

/**
 * PDF generation: model writes an outline, pdfkit renders it.
 *
 * The model is asked for a tagged plain-text format rather than JSON. JSON from
 * a model fails in a dozen ways (trailing commas, smart quotes, a stray
 * "```json" fence) and every one of them throws away a paid call. A line-based
 * format degrades instead: an unparsable line is skipped, the rest still
 * renders.
 */

const PROMPT = `Write a professional document on the topic below.

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

/**
 * Parse the tagged format into a PdfDocumentSpec.
 *
 * Any line that does not start with a known tag is ignored, which is what
 * makes the "degrade, do not throw" behaviour above actually hold.
 */
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

export async function pdfAgent(state: GraphStateType) {
  return runBilled(state.userId, "pdf", async () => {
    state.onProgress?.("Drafting the document");

    const result = await invokeModel(PROMPT + state.prompt, {
      role: "pdf",
      meter: state.meter,
    });
    const spec = parseOutline(String(result.content ?? ""), state.prompt);

    // Throwing refunds the credits rather than charging for an empty PDF.
    if (spec.sections.length === 0) {
      throw new Error("The model did not return any usable sections.");
    }

    state.onProgress?.("Rendering the PDF");

    const buffer = await renderPdf(spec);

    const saved = await saveBuffer({
      userId: state.userId,
      buffer,
      fileName: `${spec.title.replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "document"}.pdf`,
      mimeType: "application/pdf",
    });

    return {
      response: [
        `## ${spec.title}`,
        "",
        spec.subtitle ?? "",
        "",
        `PDF ready, ${spec.sections.length} sections.`,
        "",
        `[Download ${saved.name}](${saved.url})`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });
}
