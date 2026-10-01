import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Sparkles, X } from "lucide-react";
import { useChat } from "@/store/chat.store";
import ConversationList from "@/components/chat/ConversationList";
import MessageBubble from "@/components/chat/MessageBubble";
import Composer from "@/components/chat/Composer";
import ArtifactPanel from "@/components/chat/ArtifactPanel";
import ApprovalCard from "@/components/chat/ApprovalCard";
import UsageStrip from "@/components/chat/UsageStrip";
import type { Artifact } from "@/lib/types";

/**
 * The main screen: thread list, transcript, composer, and an optional
 * artifact panel on the right.
 *
 * The transcript auto-scrolls to the bottom whenever a message or a progress
 * line arrives, which is what makes a streaming answer feel live.
 */

const EXAMPLES = [
  "What's on my calendar tomorrow?",
  "Any unread mail from this week I should see?",
  "Make a 8-slide deck on retrieval augmented generation",
  "Find me 45 free minutes on Thursday afternoon",
  "Write a PDF guide to Postgres indexing",
  "Build a landing page for a coffee subscription",
];

export default function Chat() {
  const {
    messages,
    pending,
    error,
    clearError,
    loadConversations,
    loadApprovals,
    approvals,
    lastUsage,
    lastFlags,
    activeId,
    send,
  } = useChat();

  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadConversations();
    // Proposals outlive a refresh, so a pending approval must come back.
    void loadApprovals();
  }, [loadConversations, loadApprovals]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, approvals]);

  const isEmpty = messages.length === 0 && !pending;

  return (
    <div className="flex h-full">
      <ConversationList />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-3xl space-y-5">
            {isEmpty && (
              <div className="pt-16 text-center">
                <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-brand-soft">
                  <Sparkles size={22} className="text-brand" />
                </div>
                <h2 className="text-lg font-semibold">
                  {activeId ? "Ask me anything" : "Start a conversation"}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  I can reach your calendar and inbox, search the web, and build
                  documents.
                </p>

                <div className="mx-auto mt-6 grid max-w-xl gap-2 sm:grid-cols-2">
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      onClick={() => void send(example)}
                      className="rounded-xl border border-border bg-surface px-3.5 py-2.5 text-left text-xs text-muted transition hover:border-brand hover:text-ink"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onOpenArtifact={setArtifact}
              />
            ))}

            {/* The in-flight turn: a status line until the answer lands. */}
            {pending && (
              <div className="flex items-center gap-2.5 text-sm text-muted">
                <span>
                  <span className="dot">.</span>
                  <span className="dot">.</span>
                  <span className="dot">.</span>
                </span>
                {pending.status}
              </div>
            )}

            {/* Irreversible actions the agent proposed. Nothing has run yet. */}
            {approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}

            {/* What the last run cost, and which guardrails fired. */}
            {lastUsage && !pending && (
              <UsageStrip usage={lastUsage} flags={lastFlags} />
            )}

            {error && (
              <div className="flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span className="flex-1">{error}</span>
                <button onClick={clearError} title="Dismiss">
                  <X size={14} />
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        <Composer />
      </div>

      {artifact && (
        <ArtifactPanel
          artifact={artifact}
          onClose={() => setArtifact(null)}
        />
      )}
    </div>
  );
}
