import { PrismaClient } from "@prisma/client";

/**
 * A single Prisma client for the whole process.
 *
 * `globalThis` caching matters in dev: `tsx watch` re-imports modules on every
 * save, and a fresh PrismaClient per reload would leak database connections
 * until SQLite refuses to open another one.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
