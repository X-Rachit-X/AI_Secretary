import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useChat } from "@/store/chat.store";

/**
 * The thread sidebar: new chat, switch, rename, delete.
 *
 * Renaming is inline rather than in a dialog. One piece of local state holds
 * which row is being edited, which is simpler than a modal and keeps the list
 * from re-mounting while you type.
 */

export default function ConversationList() {
  const {
    conversations,
    activeId,
    openConversation,
    newConversation,
    renameConversation,
    deleteConversation,
  } = useChat();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (id: string, title: string) => {
    setEditingId(id);
    setDraft(title);
  };

  const commit = async () => {
    if (editingId && draft.trim()) {
      await renameConversation(editingId, draft.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="p-3">
        <button
          onClick={() => void newConversation()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-medium text-white transition hover:brightness-110"
        >
          <Plus size={16} />
          New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted">
            No conversations yet.
          </p>
        )}

        {conversations.map((conversation) => {
          const isActive = conversation.id === activeId;
          const isEditing = conversation.id === editingId;

          return (
            <div
              key={conversation.id}
              className={[
                "group mb-1 flex items-center gap-1 rounded-lg px-2 py-2 text-sm transition",
                isActive
                  ? "bg-surface-2 text-ink"
                  : "text-muted hover:bg-surface-2",
              ].join(" ")}
            >
              {isEditing ? (
                <>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void commit();
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-border bg-canvas px-2 py-1 text-xs outline-none focus:border-brand"
                  />
                  <button onClick={() => void commit()} title="Save">
                    <Check size={14} className="text-success" />
                  </button>
                  <button onClick={() => setEditingId(null)} title="Cancel">
                    <X size={14} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => void openConversation(conversation.id)}
                    className="min-w-0 flex-1 truncate text-left"
                    title={conversation.title}
                  >
                    {conversation.title}
                  </button>

                  {/* Row actions appear on hover to keep the list calm. */}
                  <button
                    onClick={() =>
                      startEdit(conversation.id, conversation.title)
                    }
                    className="opacity-0 transition group-hover:opacity-100"
                    title="Rename"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => void deleteConversation(conversation.id)}
                    className="opacity-0 transition hover:text-danger group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
