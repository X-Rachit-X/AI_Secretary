import { prisma } from "../db.js";
import type { Usage } from "../ai/gateway.js";

/**
 * One row per agent run: what it cost, how long it took, what the guardrails
 * said.
 *
 * This is the observability layer, and it is deliberately boring — a table and
 * two queries, not an agent framework's tracing SDK. What matters is that the
 * numbers are collected in one place and are queryable, because:
 *
 *   - "why is this slow" is answerable by agent, not by vibes
 *   - "what did this cost" is answerable before the invoice arrives
 *   - a guardrail that fires 400 times a day and a guardrail that has never
 *     fired are both telling you something, and neither is visible otherwise
 *
 * Writing a trace must never break a request, so every write is wrapped.
 */

export type TraceInput = {
  userId: string;
  conversationId?: string | null;
  agent: string;
  latencyMs: number;
  usage: Usage;
  toolCalls?: number;
  flags: string[];
  ok: boolean;
  errorTitle?: string | null;
};

export async function recordTrace(input: TraceInput) {
  try {
    await prisma.trace.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        agent: input.agent,
        latencyMs: Math.round(input.latencyMs),
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        costUsd: input.usage.costUsd,
        modelCalls: input.usage.modelCalls,
        toolCalls: input.toolCalls ?? 0,
        flags: JSON.stringify(input.flags),
        ok: input.ok,
        errorTitle: input.errorTitle ?? null,
      },
    });
  } catch (error) {
    // Telemetry is never worth failing a user's request over.
    console.warn("[trace] write failed:", (error as Error).message);
  }
}

export type InsightsSummary = {
  runs: number;
  okRate: number;
  totalCostUsd: number;
  totalTokens: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  byAgent: Array<{
    agent: string;
    runs: number;
    avgLatencyMs: number;
    costUsd: number;
    errorRate: number;
  }>;
  topFlags: Array<{ flag: string; count: number }>;
};

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) return 0;

  // Nearest-rank: with 20 samples, p95 is the 19th. Simple and honest about
  // being approximate at small sample sizes, which this always is.
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );

  return sorted[Math.max(0, index)];
}

/**
 * Everything the Insights page shows, from one query.
 *
 * Aggregating in JavaScript rather than SQL is the right call at this scale:
 * a user's recent runs are hundreds of rows, SQLite has no percentile
 * function, and the alternative is three round trips and a window function
 * nobody will want to read a year from now.
 */
export async function getInsights(
  userId: string,
  windowDays = 7,
): Promise<InsightsSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await prisma.trace.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  if (rows.length === 0) {
    return {
      runs: 0,
      okRate: 1,
      totalCostUsd: 0,
      totalTokens: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      byAgent: [],
      topFlags: [],
    };
  }

  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);

  const agents = new Map<
    string,
    { runs: number; latency: number; cost: number; errors: number }
  >();

  const flags = new Map<string, number>();

  for (const row of rows) {
    const bucket = agents.get(row.agent) ?? {
      runs: 0,
      latency: 0,
      cost: 0,
      errors: 0,
    };

    bucket.runs += 1;
    bucket.latency += row.latencyMs;
    bucket.cost += row.costUsd;
    if (!row.ok) bucket.errors += 1;

    agents.set(row.agent, bucket);

    for (const flag of JSON.parse(row.flags) as string[]) {
      flags.set(flag, (flags.get(flag) ?? 0) + 1);
    }
  }

  return {
    runs: rows.length,
    okRate: rows.filter((row) => row.ok).length / rows.length,
    totalCostUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    totalTokens: rows.reduce(
      (sum, row) => sum + row.inputTokens + row.outputTokens,
      0,
    ),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    byAgent: [...agents.entries()]
      .map(([agent, bucket]) => ({
        agent,
        runs: bucket.runs,
        avgLatencyMs: Math.round(bucket.latency / bucket.runs),
        costUsd: bucket.cost,
        errorRate: bucket.errors / bucket.runs,
      }))
      .sort((a, b) => b.runs - a.runs),
    topFlags: [...flags.entries()]
      .map(([flag, count]) => ({ flag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  };
}

export async function recentTraces(userId: string, limit = 25) {
  const rows = await prisma.trace.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    agent: row.agent,
    latencyMs: row.latencyMs,
    tokens: row.inputTokens + row.outputTokens,
    costUsd: row.costUsd,
    modelCalls: row.modelCalls,
    flags: JSON.parse(row.flags) as string[],
    ok: row.ok,
    errorTitle: row.errorTitle,
    createdAt: row.createdAt.toISOString(),
  }));
}
