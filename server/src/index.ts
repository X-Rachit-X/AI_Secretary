import { app } from "./app.js";
import { env, googleOAuthConfigured } from "./env.js";
import { prisma } from "./db.js";
import { ensureStorageDirs } from "./lib/storage.js";
import { startScheduler } from "./services/scheduler.service.js";

/**
 * Process entry point: start the HTTP listener, start the reminder cron,
 * and shut both down cleanly.
 *
 * The startup banner prints what is and is not configured. Half of all
 * "why isn't this working" time goes on a missing API key, and this makes it
 * the first thing you see.
 */

async function main() {
  await ensureStorageDirs();

  const server = app.listen(env.port, () => {
    console.log("");
    console.log("  CortexOne server");
    console.log(`  http://localhost:${env.port}`);
    console.log("");
    console.log(`  LLM provider    ${env.llmProvider}`);
    console.log(
      `  Google OAuth    ${googleOAuthConfigured ? "configured" : "MISSING (sign-in, calendar and mail are disabled)"}`,
    );
    console.log(
      `  Web search      ${env.tavilyApiKey ? "configured" : "missing (the search agent will degrade to plain chat)"}`,
    );
    console.log(`  MCP endpoint    POST ${env.serverUrl}/mcp`);
    console.log(`  Web app origin  ${env.appUrl}`);
    console.log("");
  });

  startScheduler();

  // Finish in-flight requests before exiting, and release the database handle
  // so SQLite does not leave a stale lock file behind.
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down`);

    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });

    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
