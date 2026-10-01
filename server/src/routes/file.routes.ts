import { Router } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { prisma } from "../db.js";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import { publicUrl, resolveOwnedFile } from "../lib/storage.js";
import { AppError, statusOf, toErrorBody } from "../lib/errors.js";

/**
 * Downloads for generated PDFs, decks and images.
 *
 * Every request is authenticated and scoped to the owner, which is why the
 * links in chat are plain URLs with no signature. The original project used S3
 * presigned URLs that expired in 24 hours; here the file is served by the app,
 * so an old transcript keeps working forever.
 */

export const fileRoutes = Router();

fileRoutes.use(requireAuth);

fileRoutes.get("/", async (req, res) => {
  try {
    const rows = await prisma.storedFile.findMany({
      where: { userId: currentUser(req).id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json({
      files: rows.map((row) => ({
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        url: publicUrl(row.id),
        createdAt: row.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});

fileRoutes.get("/:id", async (req, res) => {
  try {
    const file = await resolveOwnedFile(req.params.id, currentUser(req).id);

    if (!file) throw AppError.notFound("File");

    // The row can outlive the bytes if storage/ was cleared by hand.
    const stats = await stat(file.absolutePath).catch(() => null);
    if (!stats) throw AppError.notFound("File contents");

    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Length", String(stats.size));

    // Images render in the chat bubble; documents download.
    const disposition = file.mimeType.startsWith("image/")
      ? "inline"
      : "attachment";

    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(file.name)}"`,
    );

    createReadStream(file.absolutePath).pipe(res);
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});
