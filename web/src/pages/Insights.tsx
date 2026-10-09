import { useEffect, useState } from "react";
import {
  Activity,
  Coins,
  Database,
  Server,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  GatewayInfo,
  GuardrailPolicy,
  InsightsSummary,
  TraceRow,
} from "@/lib/types";

/**
 * Observability, made visible.
 *
 * Three questions this page exists to answer, none of which an agent app can
 * answer by default:
 *
 *   1. What is this costing me, and which agent is responsible?
 *   2. Which guardrails are actually firing? A rule that has never fired and a
 *      rule that fires 400 times a day both tell you something.
 *   3. Is the gateway earning its keep — are retries, fallbacks and cache hits
 *      happening?
 *
 * The policy panel reads from the server rather than hardcoding the list, so
 * what you see here is what is really being enforced.
 */

const FLAG_LABELS: Record<string, string> = {
  "input.injection_suspected": "Injection phrasing flagged",
  "input.too_long": "Prompt too long",
  "output.prompt_leak": "System prompt leak blocked",
  "output.unsafe_link": "Unsafe link stripped",
  "guardrail.untrusted_instruction_seen": "Embedded instruction in content",
  "guardrail.approval_requested": "Human approval required",
};

function labelFor(flag: string) {
  if (FLAG_LABELS[flag]) return FLAG_LABELS[flag];
  if (flag.includes(".redacted."))
    return `Redacted ${flag.split(".").pop()?.replace(/_/g, " ")}`;
  if (flag.startsWith("content.blocked."))
    return `Blocked: ${flag.split(".").pop()?.replace(/_/g, " ")}`;
  if (flag.startsWith("tool.error."))
    return `Tool failed: ${flag.replace("tool.error.", "")}`;
  return flag;
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted">
        <Icon size={12} />
        {label}
      </div>
      <div className="mt-1.5 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted">{hint}</div>}
    </div>
  );
}

export default function Insights() {
  const [summary, setSummary] = useState<InsightsSummary | null>(null);
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [policy, setPolicy] = useState<GuardrailPolicy | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.insights(7), api.guardrailPolicy()])
      .then(([insights, policyResponse]) => {
        setSummary(insights.summary);
        setTraces(insights.traces);
        setGateway(insights.gateway);
        setPolicy(policyResponse.policy);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted">
        Loading
      </div>
    );
  }

  const maxFlag = Math.max(1, ...(summary?.topFlags.map((f) => f.count) ?? [1]));

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-lg font-semibold">Insights</h1>
        <p className="mb-5 text-xs text-muted">
          Cost, latency and guardrail activity over the last 7 days
        </p>

        {summary && summary.runs === 0 ? (
          <p className="py-20 text-center text-sm text-muted">
            No runs yet. Send a message in chat and come back.
          </p>
        ) : (
          summary && (
            <>
              {/* ── Headline numbers ───────────────────────────────────── */}
              <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  icon={Activity}
                  label="Runs"
                  value={String(summary.runs)}
                  hint={`${(summary.okRate * 100).toFixed(0)}% succeeded`}
                />
                <Stat
                  icon={Coins}
                  label="Spend"
                  value={
                    summary.totalCostUsd < 0.01
                      ? `$${summary.totalCostUsd.toFixed(4)}`
                      : `$${summary.totalCostUsd.toFixed(2)}`
                  }
                  hint={`${summary.totalTokens.toLocaleString()} tokens`}
                />
                <Stat
                  icon={Timer}
                  label="Latency p50"
                  value={`${(summary.p50LatencyMs / 1000).toFixed(1)}s`}
                />
                <Stat
                  icon={Timer}
                  label="Latency p95"
                  value={`${(summary.p95LatencyMs / 1000).toFixed(1)}s`}
                  hint="the slow tail"
                />
              </div>

              {/* ── Per agent ──────────────────────────────────────────── */}
              <section className="mb-6">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  By agent
                </h2>

                <div className="overflow-hidden rounded-xl border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-2 text-left text-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Agent</th>
                        <th className="px-3 py-2 text-right font-medium">Runs</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Avg latency
                        </th>
                        <th className="px-3 py-2 text-right font-medium">Cost</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Errors
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byAgent.map((row) => (
                        <tr
                          key={row.agent}
                          className="border-t border-border bg-surface"
                        >
                          <td className="px-3 py-2 font-medium">{row.agent}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {row.runs}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {(row.avgLatencyMs / 1000).toFixed(1)}s
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {row.costUsd < 0.0001
                              ? "—"
                              : `$${row.costUsd.toFixed(4)}`}
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums ${
                              row.errorRate > 0 ? "text-danger" : "text-muted"
                            }`}
                          >
                            {(row.errorRate * 100).toFixed(0)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* ── Guardrail activity ─────────────────────────────────── */}
              <section className="mb-6">
                <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  <ShieldCheck size={13} />
                  Guardrails fired
                </h2>

                {summary.topFlags.length === 0 ? (
                  <p className="rounded-xl border border-border bg-surface p-3.5 text-xs text-muted">
                    Nothing has tripped a guardrail yet.
                  </p>
                ) : (
                  <div className="space-y-1.5 rounded-xl border border-border bg-surface p-3.5">
                    {summary.topFlags.map((entry) => (
                      <div
                        key={entry.flag}
                        className="flex items-center gap-3 text-xs"
                      >
                        <span className="w-56 shrink-0 truncate" title={entry.flag}>
                          {labelFor(entry.flag)}
                        </span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <span
                            className="block h-full rounded-full bg-brand"
                            style={{
                              width: `${(entry.count / maxFlag) * 100}%`,
                            }}
                          />
                        </span>
                        <span className="w-8 shrink-0 text-right tabular-nums text-muted">
                          {entry.count}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )
        )}

        {/* ── Gateway ──────────────────────────────────────────────────── */}
        {gateway && (
          <section className="mb-6">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <Server size={13} />
              LLM gateway
            </h2>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-border bg-surface p-3.5 text-xs sm:grid-cols-3">
              <Row label="Provider" value={gateway.provider} />
              <Row
                label="Fallback"
                value={gateway.fallbackProvider ?? "none"}
              />
              <Row label="Model timeout" value={`${gateway.timeoutMs / 1000}s`} />
              <Row
                label="Tool timeout"
                value={`${gateway.googleTimeoutMs / 1000}s`}
              />
              <Row label="Max retries" value={String(gateway.maxRetries)} />
              <Row
                label="Cache entries"
                value={`${gateway.cache.entries} / ${gateway.cache.maxEntries}`}
              />
              <Row
                label="Cache hit rate"
                value={
                  gateway.cache.hitRate === null
                    ? "no lookups yet"
                    : `${(gateway.cache.hitRate * 100).toFixed(0)}% (${gateway.cache.hits}/${
                        gateway.cache.hits + gateway.cache.misses
                      })`
                }
              />
              <Row
                label="Evictions"
                value={String(gateway.cache.evictions)}
              />
              <Row
                label="Embedding cache"
                value={
                  gateway.embeddingCache.hitRate === null
                    ? `${gateway.embeddingCache.entries} entries`
                    : `${(gateway.embeddingCache.hitRate * 100).toFixed(0)}% of ${
                        gateway.embeddingCache.hits + gateway.embeddingCache.misses
                      }`
                }
              />
            </dl>
          </section>
        )}

        {/* ── Active policy ────────────────────────────────────────────── */}
        {policy && (
          <section className="mb-6">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <Database size={13} />
              Active guardrail policy
            </h2>

            <div className="space-y-2 rounded-xl border border-border bg-surface p-3.5 text-xs">
              <div>
                <span className="text-muted">Needs human approval: </span>
                {policy.requiresApproval.map((tool) => (
                  <code
                    key={tool}
                    className="mr-1.5 rounded bg-surface-2 px-1.5 py-0.5"
                  >
                    {tool}
                  </code>
                ))}
              </div>
              <div>
                <span className="text-muted">Credential types redacted: </span>
                {policy.secretTypesDetected.length}
              </div>
              <div>
                <span className="text-muted">Blocked intents: </span>
                {policy.blockedIntents.join(", ")}
              </div>
              <div>
                <span className="text-muted">Write actions per turn: </span>
                {policy.maxWritesPerTurn}
                <span className="text-muted"> · recipients per message: </span>
                {policy.maxRecipientsPerMessage}
              </div>
            </div>
          </section>
        )}

        {/* ── Recent runs ──────────────────────────────────────────────── */}
        {traces.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Recent runs
            </h2>

            <div className="space-y-1">
              {traces.map((trace) => (
                <div
                  key={trace.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-xs"
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      trace.ok ? "bg-success" : "bg-danger"
                    }`}
                  />
                  <span className="w-24 shrink-0 font-medium">
                    {trace.agent}
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-muted">
                    {(trace.latencyMs / 1000).toFixed(1)}s
                  </span>
                  <span className="w-20 shrink-0 text-right tabular-nums text-muted">
                    {trace.tokens.toLocaleString()} tok
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted">
                    {trace.errorTitle ??
                      trace.flags.map(labelFor).join(" · ") ??
                      ""}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted">
                    {new Date(trace.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
