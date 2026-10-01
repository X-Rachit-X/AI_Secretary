import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { prisma } from "../db.js";
import { env } from "../env.js";

/**
 * Local file storage for everything the app produces or receives: generated
 * PDFs and decks, generated images, uploaded PDFs and screenshots.
 *
 * Bytes go on disk under storage/<userId>/<uuid><ext>; a StoredFile row
 * indexes them so a download can be checked against its owner.
 *
 * This replaces S3 + presigned URLs from the original project. The interface
 * is deliberately narrow (saveBuffer / publicUrl) so swapping in S3 later
 * means rewriting this file and nothing else.
 */

const STORAGE_ROOT = path.resolve(process.cwd(), "storage");
const TMP_ROOT = path.resolve(process.cwd(), "tmp");

export async function ensureStorageDirs() {
  await mkdir(STORAGE_ROOT, { recursive: true });
  await mkdir(TMP_ROOT, { recursive: true });
}

export function storageRoot() {
  return STORAGE_ROOT;
}

export function tmpRoot() {
  return TMP_ROOT;
}

/** Absolute URL the browser can hit to download a stored file. */
export function publicUrl(fileId: string) {
  return `${env.serverUrl}/api/files/${fileId}`;
}

export type SavedFile = {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  size: number;
};

export async function saveBuffer(input: {
  userId: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<SavedFile> {
  await ensureStorageDirs();

  const dir = path.join(STORAGE_ROOT, input.userId);
  await mkdir(dir, { recursive: true });

  const ext = path.extname(input.fileName) || "";
  const diskName = `${randomUUID()}${ext}`;
  const relativePath = path.join(input.userId, diskName);
  const absolutePath = path.join(STORAGE_ROOT, relativePath);

  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(absolutePath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end(input.buffer);
  });

  const row = await prisma.storedFile.create({
    data: {
      userId: input.userId,
      name: input.fileName,
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
      path: relativePath,
    },
  });

  return {
    id: row.id,
    name: row.name,
    url: publicUrl(row.id),
    mimeType: row.mimeType,
    size: row.size,
  };
}

/** Resolve a StoredFile row to an absolute path, enforcing ownership. */
export async function resolveOwnedFile(fileId: string, userId: string) {
  const row = await prisma.storedFile.findFirst({
    where: { id: fileId, userId },
  });

  if (!row) return null;

  return { ...row, absolutePath: path.join(STORAGE_ROOT, row.path) };
}

/** Best effort delete of a temp upload; a leftover temp file is not fatal. */
export async function removeQuietly(absolutePath: string) {
  await unlink(absolutePath).catch(() => {});
}
