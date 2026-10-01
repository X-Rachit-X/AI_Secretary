import { readFile } from "node:fs/promises";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { providerSupportsVision } from "../models.js";
import { invokeModel } from "../gateway.js";
import { runBilled } from "../../services/credits.service.js";
import { AppError } from "../../lib/errors.js";
import type { GraphStateType } from "../state.js";

/**
 * Reads an uploaded image: describes it, extracts text, explains charts.
 *
 * The router sends every image/* upload here, so this node never has to decide
 * whether a file is present.
 *
 * Images are passed inline as a base64 data URL. That is the format every
 * vision-capable provider in models.ts accepts, and it avoids needing a
 * publicly reachable URL for a file that was uploaded a second ago.
 */

const SYSTEM = `You are CortexOne Vision.

Rules:
- Describe only what is actually in the image. Never invent detail.
- If there is text in the image, transcribe it accurately.
- If there is a chart or table, explain what it shows, including the numbers.
- If something is blurry, cropped or ambiguous, say so rather than guessing.
- Use Markdown when it helps (a table for tabular data, bullets for a list).`;

export async function visionAgent(state: GraphStateType) {
  if (!state.file) {
    throw AppError.badRequest("No image was attached.");
  }

  if (!providerSupportsVision()) {
    throw new AppError(
      400,
      "Vision not available",
      "The configured LLM_PROVIDER cannot read images. Switch to google, openai or anthropic in server/.env.",
    );
  }

  return runBilled(state.userId, "vision", async () => {
    state.onProgress?.("Looking at the image");

    const base64 = (await readFile(state.file!.path)).toString("base64");

    const result = await invokeModel(
      [
        new SystemMessage(SYSTEM),
        new HumanMessage({
          content: [
            {
              type: "text",
              text: state.prompt?.trim() || "Describe this image in detail.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${state.file!.mimetype};base64,${base64}`,
              },
            },
          ],
        }),
      ],
      { role: "vision", meter: state.meter },
    );

    return { response: String(result.content) };
  });
}
