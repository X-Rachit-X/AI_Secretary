import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../lib/errors.js";

/**
 * Hands out authenticated Google API clients for a given user.
 *
 * Everything that talks to Google goes through here so token refresh lives in
 * exactly one place. googleapis refreshes an expired access token on its own
 * when a refresh token is set; the `tokens` listener catches the new one and
 * writes it back so the next process start does not have to refresh again.
 */

async function authFor(userId: string): Promise<OAuth2Client> {
  const account = await prisma.googleAccount.findUnique({ where: { userId } });

  if (!account) throw AppError.notConnected("Google");

  const client = new google.auth.OAuth2(
    env.oauth.clientId,
    env.oauth.clientSecret,
    env.oauth.redirectUri,
  );

  client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken ?? undefined,
    expiry_date: account.expiresAt.getTime(),
  });

  client.on("tokens", (tokens) => {
    // Fire and forget: a failed write only costs one extra refresh later.
    prisma.googleAccount
      .update({
        where: { userId },
        data: {
          ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
          ...(tokens.refresh_token
            ? { refreshToken: tokens.refresh_token }
            : {}),
          ...(tokens.expiry_date
            ? { expiresAt: new Date(tokens.expiry_date) }
            : {}),
        },
      })
      .catch(() => {});
  });

  return client;
}

/**
 * Every Google request gets a hard deadline.
 *
 * Without this there is no ceiling on a turn. The gateway caps how long a
 * MODEL call may take, but a hung `events.list` sits inside a tool call where
 * nothing is watching: the SSE stream stays open, the user's credits are
 * already spent, and the request only ends when the socket eventually dies.
 *
 * googleapis accepts per-client request options and forwards them to its HTTP
 * layer, so setting it here covers every call in calendar.ts and gmail.ts at
 * once — which is the whole reason those files go through this factory.
 */
const GOOGLE_TIMEOUT_MS = env.googleTimeoutMs;

export async function calendarFor(userId: string) {
  return google.calendar({
    version: "v3",
    auth: await authFor(userId),
    timeout: GOOGLE_TIMEOUT_MS,
  });
}

export async function gmailFor(userId: string) {
  return google.gmail({
    version: "v1",
    auth: await authFor(userId),
    timeout: GOOGLE_TIMEOUT_MS,
  });
}

/** Used by the UI to show "Connected" without making a Google call. */
export async function isGoogleConnected(userId: string) {
  const account = await prisma.googleAccount.findUnique({
    where: { userId },
    select: { id: true, scope: true },
  });

  return {
    connected: Boolean(account),
    scopes: account?.scope.split(" ").filter(Boolean) ?? [],
  };
}

export async function disconnectGoogle(userId: string) {
  await prisma.googleAccount.deleteMany({ where: { userId } });
}
