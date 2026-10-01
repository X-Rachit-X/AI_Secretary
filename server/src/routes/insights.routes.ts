import { Router } from "express";
import { currentUser, requireAuth } from "../auth/require-auth.js";
import { getInsights, recentTraces } from "../services/trace.service.js";
import { cacheStats } from "../ai/gateway.js";
import { POLICY } from "../guardrails/policy.js";
import { env } from "../env.js";
import { statusOf, toErrorBody } from "../lib/errors.js";

/**
 * Observability, exposed.
 *
 * A guardrail nobody can see is a guardrail nobody will maintain, and a cost
 * nobody can see is a cost that surprises you. This route makes both visible:
 * latency and spend per agent, which guardrails fired and how often, and what
 * the active policy actually is.
 *
 * `/policy` returning the live configuration matters more than it looks — it
 * means the UI shows what the server is really enforcing, not a hardcoded list
 * in the frontend that drifts out of date.
 */

export const insightsRoutes = Router();

insightsRoutes.use(requireAuth);

insightsRoutes.get("/", async (req, res) => {
  try {
    const userId = currentUser(req).id;
    const days = Number(req.query.days ?? 7);

    const [summary, traces] = await Promise.all([
      getInsights(userId, Number.isFinite(days) ? days : 7),
      recentTraces(userId, 25),
    ]);

    res.json({
      summary,
      traces,
      gateway: {
        provider: env.llmProvider,
        fallbackProvider: env.llmFallbackProvider ?? null,
        timeoutMs: env.llmTimeoutMs,
        maxRetries: env.llmMaxRetries,
        cache: cacheStats(),
      },
    });
  } catch (error) {
    res.status(statusOf(error)).json(toErrorBody(error));
  }
});

insightsRoutes.get("/policy", (_req, res) => {
  // Only the parts that are safe and useful to show. The regex patterns stay
  // server-side: publishing the exact injection patterns is a free hint sheet
  // for anyone trying to get around them.
  res.json({
    policy: {
      maxPromptLength: POLICY.input.maxPromptLength,
      secretTypesDetected: POLICY.input.secretPatterns.map(
        (entry) => entry.label,
      ),
      blockedIntents: POLICY.content.blockedIntents.map(
        (entry) => entry.label,
      ),
      requiresApproval: POLICY.tool.requiresApproval,
      maxWritesPerTurn: POLICY.tool.maxWritesPerTurn,
      maxRecipientsPerMessage: POLICY.tool.maxRecipientsPerMessage,
    },
  });
});
