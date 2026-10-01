import jwt from "jsonwebtoken";
import type { Response } from "express";
import { env } from "../env.js";

/**
 * Sessions as a signed JWT in an httpOnly cookie.
 *
 * The original project kept sessions in Redis. A signed cookie removes that
 * dependency: the token carries the user id and is verified with the secret,
 * so no lookup is needed on each request. The trade-off is that you cannot
 * revoke a single token early. Seven day expiry keeps that window short, and
 * every request still loads the user row, so a deleted user is rejected.
 */

const COOKIE_NAME = "cortex_session";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionClaims = {
  sub: string; // User.id
  email: string;
};

export function issueSession(res: Response, claims: SessionClaims) {
  const token = jwt.sign(claims, env.sessionSecret, { expiresIn: "7d" });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    // Only over HTTPS in production; localhost has no certificate.
    secure: env.isProd,
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
    path: "/",
  });

  return token;
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
  });
}

export function readSession(token: string | undefined): SessionClaims | null {
  if (!token) return null;

  try {
    return jwt.verify(token, env.sessionSecret) as SessionClaims;
  } catch {
    // Expired or tampered with: treat exactly like "not signed in".
    return null;
  }
}

export { COOKIE_NAME };
