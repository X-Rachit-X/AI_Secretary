import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import { graph, AGENT_CATALOG } from "../ai/graph.js";
import type { AgentName, UploadedFile } from "../ai/state.js";
import {
  autoTitle,
  recentHistory,
  saveMessage,
} from "../services/conversation.service.js";
import { getWallet } from "../services/credits.service.js";
import { openSseStream } from "../lib/sse.js";
import { removeQuietly, tmpRoot } from "../lib/storage.js";
import { AppError, statusOf, toErrorBody } from "../lib/errors.js";

/**
 * The endpoint the chat box talks to. This is where a user message becomes a
 * graph run.
 *
 * Order of operations matters:
 *  1. load history BEFORE saving the new message, or the prompt appears twice
 *     in the model's context
 *  2. open the SSE stream BEFORE invoking the graph, so progress events can be
 *     sent while it runs
 *  3. delete the upload in `finally`, whichever agent ran and however it ended
 */

export const agentRoutes = Router();

agentRoutes.use(requireAuth);

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpRoot()),
    filename: (_req, file, cb) =>
      cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed =
      file.mimetype === "application/pdf" || file.mimetype.startsWith("image/");

    // Multer types the callback as (error) | (null, accepted), so the two
    // outcomes have to be separate calls rather than one with both arguments.
    if (allowed) cb(null, true);
    else cb(new Error("Only PDF and image uploads are supported."));
  },
});

const chatSchema = z.object({
  conversationId: z.string().min(1),
  prompt: z.string().max(8000).optional().default(""),
  agent: z.string().optional().default("auto"),
});

/** The agent picker in the UI reads this, so the list never drifts from the graph. */
agentRoutes.get("/catalog", (_req, res) => {
  res.json({ agents: AGENT_CATALOG });
});

agentRoutes.post("/chat", upload.single("file"), async (req, res) => {
  const user = currentUser(req);

  const parsed = chatSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json(toErrorBody(AppError.badRequest("Invalid chat body.")));
    return;
  }

  const { conversationId, prompt, agent } = parsed.data;

  if (!prompt.trim() && !req.file) {
    res
      .status(400)
      .json(toErrorBody(AppError.badRequest("Send a message or attach a file.")));
    return;
  }

  const file: UploadedFile | undefined = req.file
    ? {
        path: req.file.path,
        mimetype: req.file.mimetype,
        originalname: req.file.originalname,
        size: req.file.size,
      }
    : undefined;

  // From here on the response is a stream: errors travel as SSE events, not as
  // HTTP status codes, because the headers are already sent.
  const stream = openSseStream(res);

  try {
    // 1. History first, so this turn is not duplicated in the model context.
    const history = await recentHistory({ conversationId, userId: user.id });

    await saveMessage({
      conversationId,
      userId: user.id,
      role: "user",
      content: prompt,
    });

    await autoTitle({
      conversationId,
      userId: user.id,
      firstMessage: prompt || req.file?.originalname || "Attachment",
    });

    stream.send({ type: "started" });

    // 2. Run the graph, forwarding each node's progress line to the browser.
    const result = await graph.invoke({
      prompt,
      userId: user.id,
      conversationId,
      history,
      file,
      agent: agent as AgentName | "auto",
      onProgress: (message: string) =>
        stream.send({ type: "progress", message }),
    });

    const response = result.response || "I could not produce an answer.";

    const saved = await saveMessage({
      conversationId,
      userId: user.id,
      role: "assistant",
      content: response,
      agent: result.agent,
      images: result.images ?? [],
      artifacts: result.artifacts ?? [],
    });

    stream.send({
      type: "completed",
      message: saved,
      wallet: await getWallet(user.id),
    });
  } catch (error) {
    console.error("[agent] run failed:", error);

    stream.send({
      type: "error",
      status: statusOf(error),
      ...toErrorBody(error),
    });
  } finally {
    // 3. The upload was only ever needed for this request.
    if (req.file) await removeQuietly(req.file.path);
    stream.close();
  }
});
