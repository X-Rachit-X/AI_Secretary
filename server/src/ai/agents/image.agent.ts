import { invokeModel } from "../gateway.js";
import { runBilled } from "../../services/credits.service.js";
import { saveBuffer } from "../../lib/storage.js";
import type { GraphStateType } from "../state.js";

/**
 * Image generation, in two steps.
 *
 * 1. A text model rewrites the user's request as a detailed image prompt.
 *    "a cat astronaut" produces a far better picture once it carries lighting,
 *    lens, composition and style, and a cheap text call is the easiest way to
 *    get that.
 * 2. The image itself comes from Pollinations, which needs no API key. The
 *    bytes are downloaded and stored locally so the picture survives in the
 *    transcript even after the provider's URL stops resolving.
 *
 * To swap in a paid provider, replace `fetchImage` and nothing else.
 */

const PROMPT_BUILDER = `You turn a short request into one detailed image generation prompt.

Include, where they make sense: subject and action, setting, lighting, mood,
colour palette, camera angle and lens, level of detail, and art style.

Return ONLY the prompt. One paragraph. No preamble, no quotes, no explanation.

Request: `;

const IMAGE_TIMEOUT_MS = 90_000;

async function fetchImage(prompt: string): Promise<Buffer> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?nologo=true`;

  // The provider can hang. Without this the request (and the user's credits)
  // would be held open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Image provider returned ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      throw new Error("Image provider did not return an image.");
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export async function imageAgent(state: GraphStateType) {
  return runBilled(state.userId, "image", async () => {
    state.onProgress?.("Designing the prompt");

    const built = await invokeModel(PROMPT_BUILDER + state.prompt, {
      role: "image",
      meter: state.meter,
    });
    const imagePrompt = String(built.content ?? "").trim() || state.prompt;

    state.onProgress?.("Generating the image");

    const buffer = await fetchImage(imagePrompt);

    const saved = await saveBuffer({
      userId: state.userId,
      buffer,
      fileName: `image-${Date.now()}.png`,
      mimeType: "image/png",
    });

    return {
      response: `![Generated image](${saved.url})\n\n[Download the image](${saved.url})`,
      // Also surfaced in state so the UI can show it in its own gallery strip.
      images: [saved.url],
    };
  });
}
