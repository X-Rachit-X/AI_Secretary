import { Coins, Gauge, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import type { Usage } from "@/lib/types";

/**
 * A one-line receipt under the last answer: tokens, cost, model calls, and
 * which guardrails fired.
 *
 * Worth putting in the product rather than only in a dashboard. Agents are
 * opaque by default — a turn that quietly made nine model calls and a turn that
 * made one look identical in the transcript. Showing the number next to the
 * answer is how you notice a prompt change doubled the cost, on the same screen
 * where you would notice it got worse.
 */

/** Guardrail labels are machine-shaped; this is what a person reads. */
const FLAG_LABELS: Record<string, string> = {
  "input.injection_suspected": "injection phrasing flagged",
  "input.too_long": "prompt too long",
  "output.prompt_leak": "prompt leak blocked",
  "output.unsafe_link": "unsafe link removed",
  "guardrail.untrusted_instruction_seen": "embedded instruction in content",
  "guardrail.approval_requested": "approval required",
};

function labelFor(flag: string) {
  if (FLAG_LABELS[flag]) return FLAG_LABELS[flag];

  // Redaction flags carry the provider: "input.redacted.openai_key".
  if (flag.includes(".redacted.")) {
    return `${flag.split(".").pop()?.replace(/_/g, " ")} redacted`;
  }

  if (flag.startsWith("tool.error.")) {
    return `${flag.replace("tool.error.", "")} failed`;
  }

  return flag;
}

function formatCost(usd: number) {
  if (usd === 0) return "—";
  // Sub-cent runs are the normal case, so two decimals would read as "$0.00".
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export default function UsageStrip({
  usage,
  flags,
}: {
  usage: Usage;
  flags: string[];
}) {
  const tokens = usage.inputTokens + usage.outputTokens;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-2.5 text-[10px] text-muted">
      <span className="flex items-center gap-1" title="Model calls this turn">
        <Zap size={11} />
        {usage.modelCalls} call{usage.modelCalls === 1 ? "" : "s"}
      </span>

      {tokens > 0 && (
        <span className="flex items-center gap-1" title="Input + output tokens">
          <Gauge size={11} />
          {tokens.toLocaleString()} tokens
        </span>
      )}

      <span className="flex items-center gap-1" title="Estimated cost">
        <Coins size={11} />
        {formatCost(usage.costUsd)}
      </span>

      {usage.cacheHits > 0 && (
        <span className="text-success" title="Served from the gateway cache">
          {usage.cacheHits} cached
        </span>
      )}

      {usage.retries > 0 && (
        <span className="flex items-center gap-1 text-warn" title="Transient failures retried">
          <RefreshCw size={11} />
          {usage.retries} retr{usage.retries === 1 ? "y" : "ies"}
        </span>
      )}

      {usage.fallbacks > 0 && (
        <span className="text-warn" title="Primary provider failed; fell back">
          fallback used
        </span>
      )}

      {flags.length > 0 && (
        <span
          className="flex items-center gap-1 text-brand"
          title={flags.join("\n")}
        >
          <ShieldCheck size={11} />
          {flags.map(labelFor).join(" · ")}
        </span>
      )}
    </div>
  );
}
