import { randomUUID } from "node:crypto";
import { invokeModel } from "../gateway.js";
import { saveBuffer, type SavedFile } from "../../lib/storage.js";
import type { Artifact } from "../../services/conversation.service.js";
import type { GenerationContext } from "./documents.js";

/**
 * Image generation and code generation, as plain functions.
 *
 * Grouped because both produce something the UI renders specially — an image
 * in the bubble, a code project in the side panel — rather than prose.
 */

// ── Image ───────────────────────────────────────────────────────────────────

const PROMPT_BUILDER = `You turn a short request into one detailed image generation prompt.

Include, where they make sense: subject and action, setting, lighting, mood,
colour palette, camera angle and lens, level of detail, and art style.

Return ONLY the prompt. One paragraph. No preamble, no quotes, no explanation.

Request: `;

const IMAGE_TIMEOUT_MS = 90_000;

async function fetchImage(prompt: string): Promise<Buffer> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?nologo=true`;

  // The provider can hang. Without this the request — and the user's credits —
  // would be held open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Image provider returned ${response.status}.`);
    }

    if (!(response.headers.get("content-type") ?? "").startsWith("image/")) {
      throw new Error("Image provider did not return an image.");
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Two steps on purpose. "A cat astronaut" produces a far better picture once it
 * carries lighting, lens, composition and style, and a cheap text call is the
 * easiest way to get that.
 *
 * The bytes are stored locally so the picture survives in the transcript after
 * the provider's URL stops resolving.
 */
export async function makeImage(
  request: string,
  context: GenerationContext,
): Promise<{ file: SavedFile; prompt: string }> {
  const built = await invokeModel(PROMPT_BUILDER + request, {
    role: "image",
    meter: context.meter,
  });

  const prompt = String(built.content ?? "").trim() || request;

  const file = await saveBuffer({
    userId: context.userId,
    buffer: await fetchImage(prompt),
    fileName: `image-${Date.now()}.png`,
    mimeType: "image/png",
  });

  return { file, prompt };
}

// ── Code ────────────────────────────────────────────────────────────────────

const CODE_PROMPT = `You are a senior front-end engineer.

FIRST decide the intent:
  BUILD   - the user wants something created (a site, a page, a component, a script)
  ADVISE  - the user wants code reviewed, explained, debugged, optimised or converted

=========================
IF ADVISE
=========================
Return Markdown only. No FILE: blocks. Structure it as:

## What this does
## Problems
## Improvements
## Fixed version   (only if a rewrite genuinely helps)

Use single backticks for identifiers, fenced blocks only for real code.

=========================
IF BUILD
=========================
Return ONLY file blocks, in this exact format, with no prose before or after:

FILE: index.html
<the full file>

FILE: style.css
<the full file>

FILE: script.js
<the full file>

Rules for BUILD:
- Default stack is plain HTML + CSS + JavaScript. Use a framework ONLY if the
  user named one.
- Single page unless the user explicitly asked for multiple pages. Use sections
  and smooth-scroll navigation instead of separate .html files.
- Modern, responsive design: CSS variables, grid, flexbox, sensible spacing,
  restrained hover and scroll animations.
- Use real https://images.unsplash.com/ URLs for imagery. Never a grey placeholder.
- Keep JavaScript minimal: interaction only.
- Stay under about 2000 tokens. Concise and good beats long and padded.

Request: `;

function stripFences(code: string) {
  return code
    .replace(/```[\w-]*\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * Split "FILE: name\n<code>" blocks out of the response.
 *
 * The lookahead stops each block at the next FILE: line or end of string, so a
 * file containing the literal text "FILE:" mid-body does not split in two.
 */
function parseFiles(content: string) {
  return [
    ...content.matchAll(/FILE:\s*([^\n]+)\n([\s\S]*?)(?=\nFILE:\s*[^\n]+\n|$)/g),
  ].map((match) => ({
    name: match[1].trim(),
    content: stripFences(match[2]),
  }));
}

export type CodeResult =
  | { kind: "advice"; markdown: string }
  | { kind: "project"; artifact: Artifact; fileNames: string[] };

/**
 * The OUTPUT SHAPE signals the intent, rather than a separate field to parse:
 * if the model emitted FILE: blocks it built something, otherwise it advised.
 * One less thing to get wrong.
 */
export async function writeCode(
  request: string,
  context: GenerationContext,
): Promise<CodeResult> {
  const result = await invokeModel(
    CODE_PROMPT + request + (context.research ? `\n\n${context.research}` : ""),
    { role: "coding", meter: context.meter },
  );

  const content = String(result.content ?? "").trim();

  // Throwing triggers the refund.
  if (!content) throw new Error("The coding model returned nothing.");

  const files = parseFiles(content);

  if (files.length === 0) return { kind: "advice", markdown: content };

  return {
    kind: "project",
    fileNames: files.map((file) => file.name),
    artifact: {
      id: randomUUID(),
      type: "project",
      title: request.slice(0, 80),
      files,
      createdAt: new Date().toISOString(),
    },
  };
}

/** Exported for the eval suite. */
export { parseFiles };
