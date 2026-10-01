import { create } from "zustand";
import { api } from "@/lib/api";
import { streamAgentChat } from "@/lib/sse";
import { useAuth } from "./auth.store";
import type {
  AgentId,
  ChatMessage,
  Conversation,
  PendingMessage,
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
 */

type ChatState = {
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  pending: PendingMessage | null;
  agent: AgentId;
  error: string | null;

  loadConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  newConversation: () => Promise<string>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  setAgent: (agent: AgentId) => void;
  send: (prompt: string, file?: File | null) => Promise<void>;
  clearError: () => void;
};

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  pending: null,
  agent: "auto",
  error: null,

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
}));
