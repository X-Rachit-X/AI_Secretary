import { create } from "zustand";
import { api } from "@/lib/api";
import { subscribeToNotifications } from "@/lib/sse";
import type { Notification } from "@/lib/types";

/**
 * The notification bell.
 *
 * Loads the current list once, then holds an SSE connection open so anything
 * the reminder cron creates appears without a refresh. `connect` is idempotent
 * because React 19 in StrictMode mounts effects twice in development, and a
 * second stream would double every notification.
 */

type NotificationState = {
  items: Notification[];
  unread: number;
  connected: boolean;

  load: () => Promise<void>;
  connect: () => void;
  disconnect: () => void;
  markRead: (id?: string) => Promise<void>;
  clear: () => Promise<void>;
  sweep: () => Promise<void>;
};

let unsubscribe: (() => void) | null = null;

type StreamEvent =
  | { type: "snapshot"; notifications: Notification[]; unread: number }
  | { type: "notification"; notification: Notification };

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  unread: 0,
  connected: false,

  load: async () => {
    const data = await api.listNotifications();
    set({ items: data.notifications, unread: data.unread });
  },

  connect: () => {
    if (unsubscribe) return;

    unsubscribe = subscribeToNotifications((raw) => {
      const event = raw as StreamEvent;

      if (event.type === "snapshot") {
        set({
          items: event.notifications,
          unread: event.unread,
          connected: true,
        });
        return;
      }

      if (event.type === "notification") {
        set((state) => ({
          items: [event.notification, ...state.items].slice(0, 50),
          unread: state.unread + 1,
        }));
      }
    });

    set({ connected: true });
  },

  disconnect: () => {
    unsubscribe?.();
    unsubscribe = null;
    set({ connected: false });
  },

  markRead: async (id) => {
    const { unread } = await api.markNotificationRead(id);

    set((state) => ({
      unread,
      items: state.items.map((item) =>
        !id || item.id === id ? { ...item, read: true } : item,
      ),
    }));
  },

  clear: async () => {
    await api.clearNotifications();
    set({ items: [], unread: 0 });
  },

  // Runs the reminder sweep immediately instead of waiting for the cron tick.
  sweep: async () => {
    await api.sweepNotifications();
    await get().load();
  },
}));
