import { useEffect, useRef, useState } from "react";
import { Paperclip, SendHorizonal, X } from "lucide-react";
import { api } from "@/lib/api";
import { useChat } from "@/store/chat.store";
import type { AgentCatalogEntry, AgentId } from "@/lib/types";

/**
 * The input box: agent picker, attachment, textarea, send.
 *
 * Three details worth noting:
 *  - Enter sends, Shift+Enter makes a newline. Standard for a chat box.
 *  - The textarea auto-grows up to a cap rather than scrolling at one line.
 *  - The agent list is fetched from /api/agent/catalog, which the server
 *    derives from the graph, so the picker can never offer an agent that does
 *    not exist.
 */

const MAX_TEXTAREA_PX = 180;

export default function Composer() {
  const { send, pending, agent, setAgent } = useChat();

  const [value, setValue] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .agentCatalog()
      .then((data) => setCatalog(data.agents))
      .catch(() => {});
  }, []);

  // Grow with the content. Resetting to "auto" first is what lets it shrink
  // again when text is deleted.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;

    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [value]);

  const busy = pending !== null;

  const submit = () => {
    const prompt = value.trim();
    if ((!prompt && !file) || busy) return;

    void send(prompt, file);

    setValue("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="border-t border-border bg-surface px-4 py-3">
      {/* Agent picker. "Auto" lets the router decide. */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {catalog.map((entry) => (
          <button
            key={entry.id}
            title={entry.hint}
            onClick={() => setAgent(entry.id as AgentId)}
            className={[
              "rounded-full border px-2.5 py-1 text-[11px] transition",
              agent === entry.id
                ? "border-brand bg-brand-soft text-ink"
                : "border-border text-muted hover:text-ink",
            ].join(" ")}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* Attachment chip. A file routes the turn to vision or document Q&A. */}
      {file && (
        <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-xs">
          <Paperclip size={12} />
          <span className="max-w-[240px] truncate">{file.name}</span>
          <button onClick={() => setFile(null)} title="Remove">
            <X size={12} className="text-muted hover:text-danger" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2 rounded-2xl border border-border bg-canvas p-2 focus-within:border-brand">
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/*"
          hidden
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />

        <button
          onClick={() => fileRef.current?.click()}
          title="Attach a PDF or an image"
          className="grid size-9 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <Paperclip size={17} />
        </button>

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Ask anything, or try: what's on my calendar tomorrow?"
          className="max-h-[180px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted"
        />

        <button
          onClick={submit}
          disabled={busy || (!value.trim() && !file)}
          title="Send"
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <SendHorizonal size={17} />
        </button>
      </div>

      <p className="mt-1.5 text-center text-[10px] text-muted">
        Enter to send, Shift+Enter for a new line
      </p>
    </div>
  );
}
