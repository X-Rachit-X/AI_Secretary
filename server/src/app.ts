import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import type { NextFunction, Request, Response } from "express";
import { env, googleOAuthConfigured } from "./env.js";
import { prisma } from "./db.js";
import { authRoutes } from "./routes/auth.routes.js";
import { chatRoutes } from "./routes/chat.routes.js";
import { agentRoutes } from "./routes/agent.routes.js";
import { calendarRoutes } from "./routes/calendar.routes.js";
import { mailRoutes } from "./routes/mail.routes.js";
import { notificationRoutes } from "./routes/notification.routes.js";
import { fileRoutes } from "./routes/file.routes.js";
import { approvalRoutes } from "./routes/approval.routes.js";
import { insightsRoutes } from "./routes/insights.routes.js";
import { mcpRoutes } from "./mcp/http.js";
import { statusOf, toErrorBody } from "./lib/errors.js";

/**
 * The Express application: middleware, the route table, the error handler.
 *
 * Separate from index.ts so the app can be imported by a test without starting
 * a listener or a cron job.
 *
 * Route map:
 *   /api/auth          sign in / out, who am I, disconnect Google
 *   /api/chat          conversations and transcripts (no LLM)
 *   /api/agent         the streaming multi-agent endpoint
 *   /api/calendar      direct Google Calendar REST (no LLM)
 *   /api/mail          direct Gmail REST (no LLM)
 *   /api/notifications list, mark read, live SSE feed
 *   /api/files         download generated documents and images
 *   /api/approvals     human-in-the-loop: approve or reject a proposed action
 *   /api/insights      latency, cost and guardrail telemetry
 *   /mcp               Model Context Protocol, for external hosts
 */

export const app = express();

app.use(
  cors({
    origin: env.appUrl,
    // Required for the session cookie to travel from the Vite dev server.
    credentials: true,
  }),
);

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

if (!env.isProd) {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.originalUrl}`);
    next();
  });
}

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "ok",
      service: "cortex-one",
      database: "up",
      llmProvider: env.llmProvider,
      llmFallback: env.llmFallbackProvider ?? "none",
      googleOAuth: googleOAuthConfigured ? "configured" : "missing",
      webSearch: env.tavilyApiKey ? "configured" : "missing",
      guardrails: "active",
    });
  } catch {
    res.status(503).json({ status: "error", database: "down" });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/calendar", calendarRoutes);
app.use("/api/mail", mailRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/approvals", approvalRoutes);
app.use("/api/insights", insightsRoutes);
app.use("/mcp", mcpRoutes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    title: "Not found",
    message: "No route matches that path.",
  });
});

/**
 * The last stop for anything thrown or passed to next().
 *
 * Multer rejections (file too large, wrong type) are user errors and get a
 * 400; everything else falls through to the generic handling in toErrorBody,
 * which never echoes an internal message it did not create.
 */
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (
    error.name === "MulterError" ||
    error.message === "Only PDF and image uploads are supported."
  ) {
    res.status(400).json({
      success: false,
      title: "Upload rejected",
      message: error.message,
    });
    return;
  }

  console.error("[error]", error);

  if (!res.headersSent) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});
