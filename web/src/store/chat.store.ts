import { create } from "zustand";
import { api } from "@/lib/api";
import { streamAgentChat } from "@/lib/sse";
import { useAuth } from "./auth.store";
import type {
  AgentId,
  ChatMessage,
  Conversation,
  PendingApproval,
  PendingMessage,
  Usage,
} from "@/lib/types";

/**
 * The chat screen's state: the sidebar list, the open transcript, and the
 * in-flight turn.
 *
 * `pending` is the key idea. While the graph runs there is no saved message
 * yet, only status lines ("Searching the web"). `pending` holds that
 * placeholder bubble; when the `completed` event arrives it is swapped for the
 * real, persisted message. The transcript therefore never contains a message
 * that does not exist on the server.
 *
 * `approvals` is the human-in-the-loop half. When the agent proposes an
 * irreversible action (send an email, cancel a meeting) the server returns it
 * here instead of doing it. Nothing happens until `approve` is called, and the
 * server then executes the stored arguments with no model involved — so what
 * runs is exactly what the user read.
 */

type ChatState = {
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  pending: PendingMessage | null;
  agent: AgentId;
  error: string | null;
  /** Irreversible actions waiting on the user. */
  approvals: PendingApproval[];
  /** Token and cost accounting for the last run. */
  lastUsage: Usage | null;
  /** Guardrail labels that fired on the last run. */
  lastFlags: string[];

  loadConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  newConversation: () => Promise<string>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  setAgent: (agent: AgentId) => void;
  send: (prompt: string, file?: File | null) => Promise<void>;
  clearError: () => void;
  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  loadApprovals: () => Promise<void>;
};

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  pending: null,
  agent: "auto",
  error: null,
  approvals: [],
  lastUsage: null,
  lastFlags: [],

  loadConversations: async () => {
    const { conversations } = await api.listConversations();
    set({ conversations });

    // Land on something rather than an empty screen.
    if (!get().activeId && conversations.length > 0) {
      await get().openConversation(conversations[0].id);
    }
  },

  openConversation: async (id) => {
    set({ activeId: id, messages: [], pending: null, error: null });

    const { messages } = await api.listMessages(id);

    // Guard against a race: the user may have clicked another thread while
    // this one was loading.
    if (get().activeId === id) set({ messages });
  },

  newConversation: async () => {
    const { conversation } = await api.createConversation();

    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeId: conversation.id,
      messages: [],
      pending: null,
      error: null,
    }));

    return conversation.id;
  },

  renameConversation: async (id, title) => {
    await api.renameConversation(id, title);

    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === id ? { ...conversation, title } : conversation,
      ),
    }));
  },

  deleteConversation: async (id) => {
    await api.deleteConversation(id);

    const remaining = get().conversations.filter(
      (conversation) => conversation.id !== id,
    );

    set({ conversations: remaining });

    if (get().activeId === id) {
      set({ activeId: null, messages: [] });
      if (remaining.length > 0) await get().openConversation(remaining[0].id);
    }
  },

  setAgent: (agent) => set({ agent }),

  clearError: () => set({ error: null }),

  send: async (prompt, file) => {
    // Sending from a cold start should still work: create a thread first.
    const conversationId = get().activeId ?? (await get().newConversation());

    // Optimistic user bubble so typing feels instant. It carries a temporary
    // id; the server's copy arrives with the completed event.
    const optimistic: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: prompt,
      agent: null,
      images: [],
      artifacts: [],
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      messages: [...state.messages, optimistic],
      pending: { role: "assistant", status: "Thinking", content: "" },
      error: null,
    }));

    try {
      await streamAgentChat(
        { conversationId, prompt, agent: get().agent, file },
        (event) => {
          if (event.type === "progress") {
            set((state) => ({
              pending: state.pending
                ? { ...state.pending, status: event.message }
                : state.pending,
            }));
            return;
          }

          if (event.type === "completed") {
            set((state) => ({
              messages: [...state.messages, event.message],
              pending: null,
              // Proposals from this run; the user decides next.
              approvals: [...state.approvals, ...(event.approvals ?? [])],
              lastUsage: event.usage ?? null,
              lastFlags: event.flags ?? [],
            }));

            // Credits were spent; keep the header counter honest.
            useAuth.getState().setWallet(event.wallet);
            return;
          }

          if (event.type === "error") {
            set({ pending: null, error: `${event.title}: ${event.message}` });
          }
        },
      );
    } catch (error) {
      set({
        pending: null,
        error: error instanceof Error ? error.message : "The request failed.",
      });
    }

    // The title may have been set from the first message; refresh the sidebar.
    const { conversations } = await api.listConversations();
    set({ conversations });
  },

  loadApprovals: async () => {
    // Proposals outlive a page refresh, so the card must come back on reload.
    const { approvals } = await api.listApprovals();
    set({ approvals });
  },

  approve: async (id) => {
    try {
      const result = await api.approveAction(id);

      set((state) => ({
        approvals: state.approvals.filter((item) => item.id !== id),
        // The server appends a confirmation turn; show it immediately.
        messages: result.message
          ? [...state.messages, result.message]
          : state.messages,
      }));
    } catch (error) {
      set((state) => ({
        // A failed approval must not leave a card that can never resolve.
        approvals: state.approvals.filter((item) => item.id !== id),
        error:
          error instanceof Error ? error.message : "Could not run that action.",
      }));
    }
  },

  reject: async (id) => {
    await api.rejectAction(id).catch(() => {});
    set((state) => ({
      approvals: state.approvals.filter((item) => item.id !== id),
    }));
  },
}));
