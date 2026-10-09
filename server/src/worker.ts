import { env } from "./env.js";
import { prisma } from "./db.js";
import { startScheduler } from "./services/scheduler.service.js";

/**
 * The background worker, as its own process.
 *
 *   npm run worker
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * By default `index.ts` starts the reminder sweep inside the web process. That
 * is the right default for one instance: one process, nothing to deploy, and
 * `node-cron` is a timer not a queue.
 *
 * It stops being right for two reasons, both of which bite in production:
 *
 *   1. **N instances means N sweeps.** Every web instance runs its own cron, so
 *      three instances do the same Google work three times. `dedupeKey` makes
 *      that SAFE — the duplicate notifications write nothing — but it is still
 *      three times the API quota for one result.
 *
 *   2. **Idle hosts suspend containers.** Fly, Railway and Render stop a
 *      container with no traffic. That also stops the cron, so reminders only
 *      fire while somebody happens to be using the app — exactly backwards for
 *      a feature whose job is to tell you about something before it happens.
 *
 * ── How to use it ───────────────────────────────────────────────────────────
 *
 * Run the web instances with the sweep off, and exactly one worker with it on:
 *
 *   web:     ENABLE_SCHEDULER=false  npm start
 *   worker:  ENABLE_SCHEDULER=true   npm run worker
 *
 * One replica of the worker, always. Two would reintroduce problem 1.
 *
 * This process holds no HTTP server, so a host that scales on request volume
 * leaves it alone.
 */

async function main() {
  // Fail loudly rather than idling forever doing nothing.
  if (!env.enableScheduler) {
    console.error(
      "[worker] ENABLE_SCHEDULER is false, so this process would do nothing. " +
        "Set it to true for the worker, and false for the web instances.",
    );
    process.exit(1);
  }

  await prisma.$queryRaw`SELECT 1`;

  console.log("");
  console.log("  AI Secretary worker");
  console.log(`  reminder sweep   ${env.reminderCron}`);
  console.log(`  lead time        ${env.reminderLeadMinutes} min`);
  console.log("  no HTTP server in this process");
  console.log("");

  startScheduler();

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] worker shutting down`);
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[worker] failed to start:", error);
  process.exit(1);
});
