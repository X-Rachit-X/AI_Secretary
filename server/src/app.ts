import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
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
 *
 * In production (SERVE_WEB=true) the built frontend is also served from here,
 * which makes a single-container deploy possible. See docs/10-DEPLOYMENT.md.
 */

export const app = express();

/**
 * CORS.
 *
 * `credentials: true` is required for the session cookie to travel from the
 * Vite dev server on a different port. When SERVE_WEB is on there is only one
 * origin and this becomes a no-op, which is the simplest deployment to reason
 * about. EXTRA_CORS_ORIGINS covers the split-host case (API and UI on
 * different domains).
 */
const allowedOrigins = [env.appUrl, ...env.extraCorsOrigins];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

// Behind a reverse proxy (Fly, Railway, Render, nginx) this is what makes
// req.protocol report "https", which the secure session cookie depends on.
if (env.isProd) app.set("trust proxy", 1);

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

/**
 * Serve the built frontend from the same process.
 *
 * In development Vite serves the app on :5173 and this block is skipped. In
 * production SERVE_WEB=true makes one container serve both the API and the UI,
 * which removes the entire CORS and cookie-domain problem: the browser only
 * ever talks to one origin.
 *
 * The SPA fallback must come AFTER every /api route, or it would swallow them,
 * and it must exclude /api and /mcp explicitly so an unknown API path still
 * returns JSON rather than the HTML shell.
 */
if (env.serveWeb) {
  const webDist = path.resolve(process.cwd(), env.webDistPath);

  if (existsSync(webDist)) {
    // Hashed asset filenames can be cached hard; index.html must not be, or a
    // deploy leaves browsers pinned to the old bundle.
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith(".html")) {
            res.setHeader("Cache-Control", "no-cache");
          } else if (
            // path.sep, not "/": on Windows this is a backslash and a
            // hardcoded forward slash would never match.
            filePath.includes(`${path.sep}assets${path.sep}`)
          ) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );

    /**
     * SPA fallback: any GET that is not an API path gets index.html, so a deep
     * link like /insights works on a hard refresh.
     *
     * Written as middleware rather than `app.get(regex, ...)` because Express 5
     * switched to path-to-regexp v8, where a bare RegExp route no longer matches
     * the way it did in Express 4. Explicit prefix checks are both portable and
     * easier to read than the lookahead they replace.
     */
    const API_PREFIXES = ["/api", "/mcp", "/health"];

    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();

      if (API_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
        return next();
      }

      // sendFile bypasses the setHeaders above, so the no-cache header has to
      // be set again here. Without it a deploy leaves browsers holding an
      // index.html that references deleted asset hashes.
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(webDist, "index.html"));
    });

    console.log(`[web] serving the built frontend from ${webDist}`);
  } else {
    console.warn(
      `[web] SERVE_WEB is on but ${webDist} does not exist. Run "npm run build" first.`,
    );
  }
}

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
