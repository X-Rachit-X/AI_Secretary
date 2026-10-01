import { useMemo, useState } from "react";
import { Download, Eye, Code2, X } from "lucide-react";
import type { Artifact } from "@/lib/types";

/**
 * The side panel for generated code projects.
 *
 * Two modes: read the files, or see the thing running. The preview is the part
 * worth explaining.
 *
 * `index.html` is rendered in a sandboxed iframe via a blob URL, with the CSS
 * and JS inlined first. Inlining is necessary because a blob document has no
 * base URL, so `<link href="style.css">` would resolve to nothing. The sandbox
 * attribute allows scripts but NOT same-origin, so generated code cannot read
 * cookies or call the API.
 */

function buildPreviewDocument(files: Artifact["files"]) {
  const html = files.find((file) => file.name.endsWith(".html"));
  if (!html) return null;

  const css = files.filter((file) => file.name.endsWith(".css"));
  const js = files.filter((file) => file.name.endsWith(".js"));

  let document = html.content;

  for (const sheet of css) {
    document = document.replace(
      new RegExp(`<link[^>]*href=["']\\.?/?${sheet.name}["'][^>]*>`, "g"),
      `<style>\n${sheet.content}\n</style>`,
    );
  }

  for (const script of js) {
    document = document.replace(
      new RegExp(`<script[^>]*src=["']\\.?/?${script.name}["'][^>]*></script>`, "g"),
      `<script>\n${script.content}\n</script>`,
    );
  }

  return document;
}

export default function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: Artifact;
  onClose: () => void;
}) {
  const [activeFile, setActiveFile] = useState(artifact.files[0]?.name ?? "");
  const [mode, setMode] = useState<"code" | "preview">("code");

  const previewDocument = useMemo(
    () => buildPreviewDocument(artifact.files),
    [artifact],
  );

  const file =
    artifact.files.find((item) => item.name === activeFile) ??
    artifact.files[0];

  const downloadFile = () => {
    if (!file) return;

    const url = URL.createObjectURL(
      new Blob([file.content], { type: "text/plain" }),
    );

    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();

    // Without this the blob stays in memory for the life of the page.
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="truncate text-sm font-medium" title={artifact.title}>
          {artifact.title}
        </span>

        <div className="flex items-center gap-1">
          {previewDocument && (
            <button
              onClick={() => setMode(mode === "code" ? "preview" : "code")}
              title={mode === "code" ? "Preview" : "Show code"}
              className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
            >
              {mode === "code" ? <Eye size={15} /> : <Code2 size={15} />}
            </button>
          )}

          <button
            onClick={downloadFile}
            title="Download this file"
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
          >
            <Download size={15} />
          </button>

          <button
            onClick={onClose}
            title="Close"
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {mode === "preview" && previewDocument ? (
        <iframe
          title="Preview"
          // allow-scripts without allow-same-origin: generated code runs but is
          // walled off from this origin's cookies and storage.
          sandbox="allow-scripts"
          srcDoc={previewDocument}
          className="min-h-0 flex-1 bg-white"
        />
      ) : (
        <>
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
            {artifact.files.map((item) => (
              <button
                key={item.name}
                onClick={() => setActiveFile(item.name)}
                className={[
                  "shrink-0 rounded-md px-2.5 py-1 text-xs transition",
                  item.name === file?.name
                    ? "bg-surface-2 text-ink"
                    : "text-muted hover:text-ink",
                ].join(" ")}
              >
                {item.name}
              </button>
            ))}
          </div>

          <pre className="min-h-0 flex-1 overflow-auto bg-canvas p-4 text-[12px] leading-relaxed">
            <code>{file?.content}</code>
          </pre>
        </>
      )}
    </aside>
  );
}
