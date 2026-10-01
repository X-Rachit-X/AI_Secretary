import { google } from "googleapis";
import { env, googleOAuthConfigured } from "../env.js";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";

/**
 * Google OAuth: sign-in and the Calendar + Gmail grant, in ONE consent screen.
 *
 * The original two projects each had their own auth stack (Firebase for login,
 * Descope outbound apps for the Calendar grant). Here a single Google consent
 * does both jobs: `openid email profile` identifies the person, and the
 * calendar/gmail scopes let the agent act for them. One click, one token set.
 */

/**
 * Scopes requested at sign-in.
 *
 * gmail.modify covers read + label changes + marking read, and is required to
 * send; gmail.send is listed explicitly so the consent screen names it.
 * Swap calendar/gmail entries for `.readonly` variants if you want the agent
 * to be able to look but never touch.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

export function oauthClient() {
  if (!googleOAuthConfigured) {
    throw new AppError(
      500,
      "Google OAuth not configured",
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env.",
    );
  }

  return new google.auth.OAuth2(
    env.oauth.clientId,
    env.oauth.clientSecret,
    env.oauth.redirectUri,
  );
}

/**
 * URL to send the browser to.
 *
 * `access_type: "offline"` + `prompt: "consent"` is what makes Google return a
 * refresh token. Without it you get an access token that dies in an hour and
 * the agent stops working with no obvious cause.
 */
export function buildConsentUrl(state: string) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
  });
}

export type GoogleProfile = {
  googleId: string;
  email: string;
  name?: string;
  avatar?: string;
};

/** Exchange the one-time code for tokens and look up who signed in. */
export async function exchangeCode(code: string) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    throw AppError.badRequest("Google did not return an access token.");
  }

  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data } = await oauth2.userinfo.get();

  if (!data.id || !data.email) {
    throw AppError.badRequest("Google did not return a profile.");
  }

  const profile: GoogleProfile = {
    googleId: data.id,
    email: data.email,
    name: data.name ?? undefined,
    avatar: data.picture ?? undefined,
  };

  return { tokens, profile };
}

/**
 * Create or update the user plus their stored Google grant.
 *
 * Google only sends a refresh token on the FIRST consent for an app. On a
 * re-consent `tokens.refresh_token` is often undefined, so we keep the one
 * already on file instead of overwriting it with null.
 */
export async function upsertUserFromGoogle(input: {
  profile: GoogleProfile;
  accessToken: string;
  refreshToken?: string | null;
  scope: string;
  expiryDate?: number | null;
}) {
  const { profile } = input;

  const user = await prisma.user.upsert({
    where: { googleId: profile.googleId },
    create: {
      googleId: profile.googleId,
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar,
    },
    update: {
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar,
    },
  });

  const expiresAt = new Date(input.expiryDate ?? Date.now() + 3600 * 1000);
  const existing = await prisma.googleAccount.findUnique({
    where: { userId: user.id },
  });

  await prisma.googleAccount.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? null,
      scope: input.scope,
      expiresAt,
    },
    update: {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? existing?.refreshToken ?? null,
      scope: input.scope,
      expiresAt,
    },
  });

  return user;
}
