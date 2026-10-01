import { randomUUID } from "node:crypto";
import { invokeModel } from "../gateway.js";
import { runBilled } from "../../services/credits.service.js";
import type { Artifact } from "../../services/conversation.service.js";
import type { GraphStateType } from "../state.js";

/**
 * Code generation, review and explanation.
 *
 * Produces one of two shapes depending on what the user asked:
 *  - a build request  -> an ARTIFACT: a set of named files the UI shows in a
 *                        side panel with tabs and a live preview
 *  - a review/explain -> plain Markdown in the chat bubble
 *
 * The model signals which by whether it emits "FILE:" blocks. That is simpler
 * and more robust than asking it to also classify its own intent in a separate
 * field we would then have to parse.
 */

const PROMPT = `You are CortexOne Coding Agent.

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
- Keep JavaScript minimal: interaction only, no frameworks-in-disguise.
- Stay under about 2000 tokens. Concise and good beats long and padded.

User request:
`;

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

export async function codingAgent(state: GraphStateType) {
  return runBilled(state.userId, "coding", async () => {
    state.onProgress?.("Writing code");

    const result = await invokeModel(PROMPT + state.prompt, {
      role: "coding",
      meter: state.meter,
    });
    const content = String(result.content ?? "").trim();

    // Throwing triggers the refund inside runBilled.
    if (!content) throw new Error("The coding model returned nothing.");

    const files = parseFiles(content);

    // ADVISE path: the Markdown is the whole answer.
    if (files.length === 0) {
      return { response: content, artifacts: [] };
    }

    const artifact: Artifact = {
      id: randomUUID(),
      type: "project",
      title: state.prompt.slice(0, 80),
      files,
      createdAt: new Date().toISOString(),
    };

    return {
      response: `Built **${files.length} file${files.length === 1 ? "" : "s"}**: ${files
        .map((file) => `\`${file.name}\``)
        .join(", ")}. Open the panel on the right to view, preview and download.`,
      artifacts: [artifact],
    };
  });
}
