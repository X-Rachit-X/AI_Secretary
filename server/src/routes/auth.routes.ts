import { randomBytes } from "node:crypto";
import { Router } from "express";
import { env, googleOAuthConfigured } from "../env.js";
import {
  buildConsentUrl,
  exchangeCode,
  upsertUserFromGoogle,
} from "../auth/google-oauth.js";
import { clearSession, issueSession } from "../auth/session.js";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import { disconnectGoogle, isGoogleConnected } from "../google/client.js";
import { getWallet } from "../services/credits.service.js";
import { statusOf, toErrorBody } from "../lib/errors.js";

/**
 * Sign in, sign out, and "who am I".
 *
 * The whole flow:
 *   GET  /api/auth/google           -> redirect the browser to Google
 *   GET  /api/auth/google/callback  -> Google redirects back with a code
 *                                      exchange it, create the session cookie,
 *                                      bounce to the web app
 *   GET  /api/auth/me               -> the signed-in user, wallet and
 *                                      connection status
 */

export const authRoutes = Router();

/**
 * CSRF protection for the OAuth round trip.
 *
 * A random `state` is minted before the redirect and must come back unchanged,
 * which stops an attacker from feeding the callback their own auth code. Held
 * in memory with a short TTL because it only has to survive one redirect.
 */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function mintState() {
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state: string | undefined) {
  if (!state) return false;

  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);

  // Opportunistic cleanup of anything else that has expired.
  const now = Date.now();
  for (const [key, expiry] of pendingStates) {
    if (expiry <= now) pendingStates.delete(key);
  }

  return Boolean(expiresAt && expiresAt > now);
}

authRoutes.get("/google", (_req, res) => {
  if (!googleOAuthConfigured) {
    res.status(500).json({
      success: false,
      title: "Google sign-in not configured",
      message:
        "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env, then restart.",
    });
    return;
  }

  res.redirect(buildConsentUrl(mintState()));
});

authRoutes.get("/google/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state =
    typeof req.query.state === "string" ? req.query.state : undefined;

  // The user clicked Cancel on the consent screen.
  if (req.query.error) {
    res.redirect(`${env.appUrl}/login?error=denied`);
    return;
  }

  if (!code || !consumeState(state)) {
    res.redirect(`${env.appUrl}/login?error=invalid_state`);
    return;
  }

  try {
    const { tokens, profile } = await exchangeCode(code);

    const user = await upsertUserFromGoogle({
      profile,
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope ?? "",
      expiryDate: tokens.expiry_date,
    });

    issueSession(res, { sub: user.id, email: user.email });

    res.redirect(`${env.appUrl}/chat`);
  } catch (error) {
    console.error("[auth] callback failed:", error);
    res.redirect(`${env.appUrl}/login?error=exchange_failed`);
  }
});

authRoutes.post("/logout", (_req, res) => {
  clearSession(res);
  res.json({ success: true });
});

authRoutes.get("/me", requireAuth, async (req, res) => {
  try {
    const user = currentUser(req);

    const [wallet, google] = await Promise.all([
      getWallet(user.id),
      isGoogleConnected(user.id),
    ]);

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
      },
      wallet,
      google,
    });
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});

/**
 * Revoke the stored Google grant without deleting the account. The user keeps
 * their chat history and can reconnect from the sidebar.
 */
authRoutes.post("/google/disconnect", requireAuth, async (req, res) => {
  try {
    await disconnectGoogle(currentUser(req).id);
    res.json({ success: true });
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});
