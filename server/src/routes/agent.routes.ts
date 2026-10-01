import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import { graph, AGENT_CATALOG } from "../ai/graph.js";
import { UsageMeter } from "../ai/gateway.js";
import type { AgentName, UploadedFile } from "../ai/state.js";
import {
  autoTitle,
  recentHistory,
  saveMessage,
} from "../services/conversation.service.js";
import { getWallet } from "../services/credits.service.js";
import { recordTrace } from "../services/trace.service.js";
import { openSseStream } from "../lib/sse.js";
import { removeQuietly, tmpRoot } from "../lib/storage.js";
import { AppError, statusOf, toErrorBody } from "../lib/errors.js";
import {
  closeTurn,
  guardInput,
  guardOutput,
  openTurn,
  pendingForTurn,
} from "../guardrails/index.js";

/**
 * The endpoint the chat box talks to. This is where a user message becomes a
 * graph run, and where the guardrails and telemetry bracket it.
 *
 * Order of operations matters:
 *  1. INPUT GUARD first. A blocked message must never reach the model, and a
 *     message with a credential in it must be redacted before it does.
 *  2. load history BEFORE saving the new message, or the prompt appears twice
 *     in the model's context
 *  3. open the SSE stream BEFORE invoking the graph, so progress events can be
 *     sent while it runs
 *  4. OUTPUT GUARD on the answer before it is persisted, not just before it is
 *     displayed — a leaked secret in the database is still leaked
 *  5. record a Trace row for the run, whatever happened
 *  6. delete the upload and close the turn in `finally`
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
  prompt: z.string().max(12000).optional().default(""),
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

  const { conversationId, agent } = parsed.data;

  if (!parsed.data.prompt.trim() && !req.file) {
    res
      .status(400)
      .json(toErrorBody(AppError.badRequest("Send a message or attach a file.")));
    return;
  }

  // 1. Input guard. Runs before the stream opens so a rejection is a plain
  //    HTTP error rather than an SSE event the UI has to special-case.
  const inputVerdict = guardInput(parsed.data.prompt);

  if (!inputVerdict.ok) {
    await recordTrace({
      userId: user.id,
      conversationId,
      agent: "blocked",
      latencyMs: 0,
      usage: new UsageMeter().usage,
      flags: inputVerdict.flags,
      ok: false,
      errorTitle: "Blocked by guardrail",
    });

    if (req.file) await removeQuietly(req.file.path);

    res.status(422).json({
      success: false,
      title: "Blocked",
      message: inputVerdict.reason,
      flags: inputVerdict.flags,
    });
    return;
  }

  // The redacted text is what gets stored and sent to the model from here on.
  const prompt = inputVerdict.value;

  const file: UploadedFile | undefined = req.file
    ? {
        path: req.file.path,
        mimetype: req.file.mimetype,
        originalname: req.file.originalname,
        size: req.file.size,
      }
    : undefined;

  const turnId = randomUUID();
  const meter = new UsageMeter();
  const startedAt = Date.now();
  const turnBegan = new Date();

  openTurn(turnId);

  // From here on the response is a stream: errors travel as SSE events, not as
  // HTTP status codes, because the headers are already sent.
  const stream = openSseStream(res);

  let resolvedAgent = "unknown";
  const flags = [...inputVerdict.flags];

  try {
    // 2. History first, so this turn is not duplicated in the model context.
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

    // 3. Run the graph, forwarding each node's progress line to the browser.
    const result = await graph.invoke({
      prompt,
      userId: user.id,
      conversationId,
      history,
      file,
      agent: agent as AgentName | "auto",
      turnId,
      meter,
      suspicious: inputVerdict.flags.includes("input.injection_suspected"),
      onProgress: (message: string) =>
        stream.send({ type: "progress", message }),
    });

    resolvedAgent = result.agent ?? "unknown";
    flags.push(...(result.flags ?? []));

    // 4. Output guard before persistence.
    const outputVerdict = guardOutput(
      result.response || "I could not produce an answer.",
    );

    flags.push(...outputVerdict.flags);

    const saved = await saveMessage({
      conversationId,
      userId: user.id,
      role: "assistant",
      content: outputVerdict.value,
      agent: resolvedAgent,
      images: result.images ?? [],
      artifacts: result.artifacts ?? [],
    });

    // Anything the tool guard proposed during this run needs the user's
    // decision, so it rides along with the finished message.
    const approvals = await pendingForTurn(user.id, conversationId, turnBegan);

    if (approvals.length > 0) flags.push("guardrail.approval_requested");

    stream.send({
      type: "completed",
      message: saved,
      wallet: await getWallet(user.id),
      approvals,
      usage: meter.usage,
      flags,
    });

    await recordTrace({
      userId: user.id,
      conversationId,
      agent: resolvedAgent,
      latencyMs: Date.now() - startedAt,
      usage: meter.usage,
      toolCalls: result.toolCalls ?? 0,
      flags,
      ok: true,
    });
  } catch (error) {
    console.error("[agent] run failed:", error);

    stream.send({
      type: "error",
      status: statusOf(error),
      ...toErrorBody(error),
    });

    await recordTrace({
      userId: user.id,
      conversationId,
      agent: resolvedAgent,
      latencyMs: Date.now() - startedAt,
      usage: meter.usage,
      flags,
      ok: false,
      errorTitle:
        error instanceof AppError ? error.title : "Internal error",
    });
  } finally {
    // 5. The upload was only ever needed for this request, and the write
    //    budget must not outlive the turn it belongs to.
    if (req.file) await removeQuietly(req.file.path);
    closeTurn(turnId);
    stream.close();
  }
});
