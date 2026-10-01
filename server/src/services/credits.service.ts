import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { checkRateLimit } from "./ratelimit.service.js";

/**
 * Credit wallet.
 *
 * Every agent run costs credits. The important rule is: charge BEFORE doing
 * the work, refund if the work throws. Charging afterwards would let a user
 * with an empty wallet burn paid LLM and image-generation calls and only find
 * out at the end.
 */

/** Cost of one run, per agent. Keep in sync with the UI badge in web/. */
export const AGENT_COST: Record<string, number> = {
  chat: 1,
  search: 5,
  coding: 10,
  pdf: 10,
  ppt: 10,
  image: 10,
  vision: 10,
  docqa: 5,
  workspace: 3,
};

export function costOf(agent: string) {
  return AGENT_COST[agent] ?? 1;
}

/**
 * Check-and-decrement in ONE atomic update.
 *
 * `updateMany` with `credits: { gte: cost }` in the WHERE clause means the
 * database does the balance check. A read-then-write would let two parallel
 * requests both pass the check and push the balance negative.
 */
async function charge(userId: string, agent: string) {
  const cost = costOf(agent);

  const result = await prisma.user.updateMany({
    where: { id: userId, credits: { gte: cost } },
    data: { credits: { decrement: cost } },
  });

  if (result.count === 0) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });

    throw AppError.insufficientCredits(cost, user?.credits ?? 0);
  }

  return cost;
}

/** Compensating action after a failed run. Best effort: never masks the real error. */
async function refund(userId: string, agent: string) {
  await prisma.user
    .update({
      where: { id: userId },
      data: { credits: { increment: costOf(agent) } },
    })
    .catch(() => {});
}

/**
 * The wrapper every agent node runs inside: rate limit, charge, run, refund on
 * failure. Having it in one place is why no individual agent has to remember
 * the ordering.
 */
export async function runBilled<T>(
  userId: string,
  agent: string,
  work: () => Promise<T>,
): Promise<T> {
  await checkRateLimit(userId, agent);
  await charge(userId, agent);

  try {
    return await work();
  } catch (error) {
    await refund(userId, agent);
    throw error;
  }
}

export async function getWallet(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { credits: true, totalCredits: true },
  });

  return {
    credits: user?.credits ?? 0,
    totalCredits: user?.totalCredits ?? 0,
  };
}

/**
 * Top up a wallet. This is the single hook point a payment provider would call
 * after a verified webhook; the app itself stays payment-agnostic.
 */
export async function grantCredits(userId: string, amount: number) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      credits: { increment: amount },
      totalCredits: { increment: amount },
    },
    select: { credits: true, totalCredits: true },
  });
}
