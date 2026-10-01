import { useEffect, useState } from "react";
import { Download, FileImage, FileText, Presentation } from "lucide-react";
import { api } from "@/lib/api";
import type { StoredFile } from "@/lib/types";

/**
 * Everything the agents have produced: PDFs, decks and images.
 *
 * Because files are served by this app rather than from expiring presigned
 * URLs, an old chat link still works months later, and this page is the
 * permanent index of them.
 */

function iconFor(mimeType: string) {
  if (mimeType.startsWith("image/")) return FileImage;
  if (mimeType.includes("presentation")) return Presentation;
  return FileText;
}

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Files() {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listFiles()
      .then((data) => setFiles(data.files))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-lg font-semibold">Files</h1>
        <p className="mb-5 text-xs text-muted">
          Documents, decks and images the assistant generated for you
        </p>

        {!loading && files.length === 0 && (
          <p className="py-20 text-center text-sm text-muted">
            Nothing generated yet. Ask for a PDF, a deck or an image in chat.
          </p>
        )}

        <div className="space-y-2">
          {files.map((file) => {
            const Icon = iconFor(file.mimeType);

            return (
              <a
                key={file.id}
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3.5 transition hover:border-brand"
              >
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft">
                  <Icon size={16} className="text-brand" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{file.name}</div>
                  <div className="text-xs text-muted">
                    {humanSize(file.size)} ·{" "}
                    {new Date(file.createdAt).toLocaleDateString()}
                  </div>
                </div>

                <Download size={15} className="shrink-0 text-muted" />
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}
