/**
 * The eval harness, in types.
 *
 * Why evals in a project this size: every behaviour that matters here is
 * decided by a prompt or a regex, and both are the kind of thing that silently
 * regresses. Change one line of the router prompt and routing accuracy can
 * drop ten points with nothing failing and no error in the logs. A test suite
 * that only checks types will never notice.
 *
 * Two suites, and the split is the important design decision:
 *
 *   OFFLINE  pure functions — guardrails, parsers, the vector store. No API
 *            key, no network, deterministic, runs in a second. Safe in CI, and
 *            it covers every guardrail, which is exactly the code you least
 *            want to regress.
 *
 *   LIVE     needs a model — router accuracy, tool selection. Costs money and
 *            is non-deterministic, so it is opt-in with --live.
 *
 * Keeping them separate means "did I break the guardrails?" is always
 * answerable for free, and "did I make routing worse?" is answerable when you
 * are about to ship a prompt change.
 */

export type EvalCase = {
  /** Stable id, so a failure can be pointed at. */
  id: string;
  /** What this case is actually checking, in one line. */
  about: string;
  input: unknown;
  expected: unknown;
};

export type CaseResult = {
  id: string;
  about: string;
  passed: boolean;
  /** 0..1. Binary checks use 0 or 1; graded ones can be partial. */
  score: number;
  expected: unknown;
  actual: unknown;
  note?: string;
};

export type SuiteResult = {
  suite: string;
  kind: "offline" | "live";
  cases: CaseResult[];
  passed: number;
  failed: number;
  score: number;
  durationMs: number;
};

export type Suite = {
  name: string;
  kind: "offline" | "live";
  /** One line shown in the report header. */
  about: string;
  run: () => Promise<CaseResult[]>;
};
