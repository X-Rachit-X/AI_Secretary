import { useCallback, useEffect, useState } from "react";
import { CornerUpLeft, Inbox, RefreshCw, Search, Send, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/store/auth.store";
import type { MailDetail, MailSummary } from "@/lib/types";

/**
 * The Mail page: a two-pane inbox with search, reading and replying.
 *
 * The search box takes raw Gmail query syntax, the same strings the agent's
 * `search_mail` tool builds. Quick filter chips cover the common cases so you
 * do not have to remember the operators.
 */

const FILTERS = [
  { label: "Inbox", query: "in:inbox" },
  { label: "Unread", query: "is:unread in:inbox" },
  { label: "Today", query: "newer_than:1d in:inbox" },
  { label: "Starred", query: "is:starred" },
  { label: "Sent", query: "in:sent" },
];

/** Gmail sends "Jane Doe <jane@x.com>". Show the name when there is one. */
function displayName(from: string) {
  const match = from.match(/^(.*?)\s*<.*>$/);
  return (match?.[1] || from).replace(/"/g, "").trim();
}

export default function Mail() {
  const google = useAuth((state) => state.google);

  const [query, setQuery] = useState("in:inbox");
  const [messages, setMessages] = useState<MailSummary[]>([]);
  const [selected, setSelected] = useState<MailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async (searchQuery: string) => {
    setLoading(true);
    setError(null);

    try {
      const data = await api.listMail(searchQuery, 20);
      setMessages(data.messages);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not load mail.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(query);
    // Re-runs only when the query actually changes, not on every keystroke:
    // `query` updates on submit and on filter clicks.
  }, [load, query]);

  const open = async (id: string) => {
    setReply("");

    try {
      const data = await api.readMail(id);
      setSelected(data.message);

      // Opening a message marks it read, as any mail client would.
      if (data.message.unread) {
        await api.markMailRead(id).catch(() => {});
        setMessages((current) =>
          current.map((item) =>
            item.id === id ? { ...item, unread: false } : item,
          ),
        );
      }
    } catch {
      setError("Could not open that message.");
    }
  };

  const sendReply = async () => {
    if (!selected || !reply.trim()) return;

    setSending(true);

    try {
      await api.replyMail(selected.id, reply.trim());
      setReply("");
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not send the reply.",
      );
    } finally {
      setSending(false);
    }
  };

  if (!google.connected) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div>
          <Inbox size={34} className="mx-auto mb-3 text-muted" />
          <p className="text-sm text-muted">
            Google is not connected. Sign out and sign in again to grant access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* ── List pane ─────────────────────────────────────────────────── */}
      <div className="flex w-[380px] shrink-0 flex-col border-r border-border">
        <div className="shrink-0 space-y-2 border-b border-border p-3">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void load(query);
            }}
            className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-2.5 py-1.5 focus-within:border-brand"
          >
            <Search size={14} className="shrink-0 text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="is:unread from:someone@x.com"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted"
            />
            <button
              type="button"
              onClick={() => void load(query)}
              title="Refresh"
            >
              <RefreshCw
                size={13}
                className={`text-muted ${loading ? "animate-spin" : ""}`}
              />
            </button>
          </form>

          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((filter) => (
              <button
                key={filter.label}
                onClick={() => setQuery(filter.query)}
                className={[
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition",
                  query === filter.query
                    ? "border-brand bg-brand-soft text-ink"
                    : "border-border text-muted hover:text-ink",
                ].join(" ")}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loading && messages.length === 0 && (
            <p className="py-12 text-center text-xs text-muted">
              No messages match that search.
            </p>
          )}

          {messages.map((message) => (
            <button
              key={message.id}
              onClick={() => void open(message.id)}
              className={[
                "block w-full border-b border-border px-3.5 py-3 text-left transition hover:bg-surface",
                selected?.id === message.id ? "bg-surface-2" : "",
              ].join(" ")}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={`truncate text-xs ${
                    message.unread ? "font-semibold text-ink" : "text-muted"
                  }`}
                >
                  {displayName(message.from)}
                </span>

                <span className="shrink-0 text-[10px] text-muted">
                  {message.date
                    ? new Date(message.date).toLocaleDateString([], {
                        day: "numeric",
                        month: "short",
                      })
                    : ""}
                </span>
              </div>

              <div
                className={`mt-0.5 truncate text-sm ${
                  message.unread ? "font-medium text-ink" : "text-muted"
                }`}
              >
                {message.subject}
              </div>

              <div className="mt-0.5 truncate text-xs text-muted">
                {message.snippet}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Reading pane ──────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {error && (
          <div className="m-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">
            {error}
          </div>
        )}

        {!selected ? (
          <div className="grid h-full place-items-center text-sm text-muted">
            Select a message to read it.
          </div>
        ) : (
          <article className="mx-auto max-w-2xl px-6 py-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <h1 className="text-lg font-semibold">{selected.subject}</h1>
              <button
                onClick={() => setSelected(null)}
                title="Close"
                className="shrink-0 text-muted hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mb-4 border-b border-border pb-3 text-xs text-muted">
              <div>
                <span className="text-ink">{displayName(selected.from)}</span>{" "}
                {selected.from.includes("<") && selected.from.match(/<(.*)>/)?.[1]}
              </div>
              <div className="mt-0.5">
                to {selected.to} ·{" "}
                {selected.date ? new Date(selected.date).toLocaleString() : ""}
              </div>
            </div>

            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink/90">
              {selected.body}
            </pre>

            <div className="mt-6 rounded-2xl border border-border bg-surface p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                <CornerUpLeft size={13} />
                Reply to {displayName(selected.from)}
              </div>

              <textarea
                rows={4}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="Write your reply, or ask the assistant to draft it in chat."
                className="w-full resize-none rounded-lg border border-border bg-canvas px-3 py-2 text-sm outline-none focus:border-brand"
              />

              <div className="mt-2 flex justify-end">
                <button
                  onClick={() => void sendReply()}
                  disabled={!reply.trim() || sending}
                  className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-40"
                >
                  <Send size={14} />
                  {sending ? "Sending" : "Send reply"}
                </button>
              </div>
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
