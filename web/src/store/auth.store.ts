import { create } from "zustand";
import { api } from "@/lib/api";
import type { GoogleStatus, User, Wallet } from "@/lib/types";

/**
 * Who is signed in, how many credits they have, and whether Google is linked.
 *
 * `status` drives routing. It starts as "loading" rather than "signed-out" on
 * purpose: treating an unfinished session check as signed-out would bounce
 * every page refresh to the login screen for a moment.
 */

type AuthState = {
  status: "loading" | "authed" | "anon";
  user: User | null;
  wallet: Wallet;
  google: GoogleStatus;

  load: () => Promise<void>;
  setWallet: (wallet: Wallet) => void;
  logout: () => Promise<void>;
  disconnectGoogle: () => Promise<void>;
};

export const useAuth = create<AuthState>((set) => ({
  status: "loading",
  user: null,
  wallet: { credits: 0, totalCredits: 0 },
  google: { connected: false, scopes: [] },

  load: async () => {
    try {
      const data = await api.me();

      set({
        status: "authed",
        user: data.user,
        wallet: data.wallet,
        google: data.google,
      });
    } catch {
      // A 401 here is the normal "not signed in yet" case, not an error.
      set({ status: "anon", user: null });
    }
  },

  // Called after every agent run so the credit counter stays live.
  setWallet: (wallet) => set({ wallet }),

  logout: async () => {
    await api.logout().catch(() => {});
    set({ status: "anon", user: null, google: { connected: false, scopes: [] } });
  },

  disconnectGoogle: async () => {
    await api.disconnectGoogle();
    set({ google: { connected: false, scopes: [] } });
  },
}));
