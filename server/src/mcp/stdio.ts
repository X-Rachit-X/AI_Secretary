import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { prisma } from "../db.js";
import { buildMcpServer } from "./mcp.tools.js";

/**
 * MCP over stdio, for local hosts like Claude Desktop and Cursor.
 *
 * Run it with:  npm run mcp
 *
 * Claude Desktop config (claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "ai-secretary": {
 *         "command": "npx",
 *         "args": ["tsx", "src/mcp/stdio.ts"],
 *         "cwd": "<absolute path to>/ai-secretary/server",
 *         "env": { "SECRETARY_USER_EMAIL": "you@example.com" }
 *       }
 *     }
 *   }
 *
 * There is no OAuth round trip here: a stdio server runs on the user's own
 * machine with no browser. It identifies the user by SECRETARY_USER_EMAIL, which
 * must match an account that has already signed in through the web app, so the
 * Google tokens are in the database. The HTTP transport in http.ts is the one
 * to use for anything remote.
 *
 * IMPORTANT: stdout is the protocol channel. Anything printed there corrupts
 * the stream, so every log in this file goes to stderr.
 */

async function resolveUserId() {
  const email = process.env.SECRETARY_USER_EMAIL;

  if (email) {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      throw new Error(
        `No AI Secretary account found for ${email}. Sign in through the web app first.`,
      );
    }

    return user.id;
  }

  // Convenience for single-user local setups: if there is exactly one account,
  // use it. More than one is ambiguous, so demand the variable.
  const users = await prisma.user.findMany({ take: 2, select: { id: true, email: true } });

  if (users.length === 1) return users[0].id;

  if (users.length === 0) {
    throw new Error(
      "No AI Secretary accounts exist yet. Start the app and sign in with Google first.",
    );
  }

  throw new Error(
    "Several accounts exist. Set SECRETARY_USER_EMAIL to pick one.",
  );
}

async function main() {
  const userId = await resolveUserId();

  const server = buildMcpServer(userId);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error("[mcp] ai-secretary stdio server ready");
}

main().catch((error) => {
  console.error("[mcp] failed to start:", error.message);
  process.exit(1);
});
