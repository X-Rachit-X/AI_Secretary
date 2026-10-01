import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { COOKIE_NAME, readSession } from "./session.js";
import { AppError, statusOf, toErrorBody } from "../lib/errors.js";

/**
 * Gate for every private route.
 *
 * Reads the session cookie, verifies it, then loads the user row and hangs it
 * on `req.user`. Loading the row (rather than trusting the token alone) means
 * credits and profile changes take effect immediately and a deleted account
 * cannot keep using an old cookie.
 */

export type AuthedUser = {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  credits: number;
  totalCredits: number;
  googleConnected: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // Browsers send the cookie; the MCP bridge and CLI tools send a header.
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim()
      : undefined;

    const claims = readSession(req.cookies?.[COOKIE_NAME] ?? bearer);

    if (!claims) throw AppError.unauthorized();

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      include: { googleAccount: { select: { id: true } } },
    });

    if (!user) throw AppError.unauthorized("Your account no longer exists.");

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      credits: user.credits,
      totalCredits: user.totalCredits,
      googleConnected: Boolean(user.googleAccount),
    };

    next();
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
}

/** Convenience for route handlers: `req.user` is guaranteed after requireAuth. */
export function currentUser(req: Request): AuthedUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
