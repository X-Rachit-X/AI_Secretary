import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import { buildMcpServer } from "./mcp.tools.js";
import { statusOf, toErrorBody } from "../lib/errors.js";

/**
 * MCP over Streamable HTTP, mounted at POST /mcp.
 *
 * Authentication is the same session cookie or Bearer token the rest of the
 * API uses, so an MCP host connects as a specific signed-in user and the tools
 * are bound to that user's Google account.
 *
 * Stateless mode: a fresh server and transport per request, no session id to
 * track. Each tool call is independent here, so there is no state worth
 * keeping between them, and this way a restart never strands a client.
 */

export const mcpRoutes = Router();

mcpRoutes.post("/", requireAuth, async (req, res) => {
  try {
    const userId = currentUser(req).id;

    const server = buildMcpServer(userId);

    const transport = new StreamableHTTPServerTransport({
      // undefined = stateless; the SDK will not issue or expect a session id.
      sessionIdGenerator: undefined,
    });

    // Tear down both sides together, or each request leaks a server object.
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[mcp] request failed:", error);

    if (!res.headersSent) {
      res.status(statusOf(error)).json(toErrorBody(error));
    }
  }
});

/**
 * Some hosts probe with GET before posting. Answering 405 with an Allow header
 * is the correct, and far clearer, response than a 404.
 */
mcpRoutes.get("/", (_req, res) => {
  res.status(405).set("Allow", "POST").json({
    success: false,
    title: "Method not allowed",
    message: "The MCP endpoint accepts POST requests only.",
  });
});
