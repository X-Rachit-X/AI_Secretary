import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { guardrailSuite } from "./guardrails.eval.js";
import { parserSuite } from "./parsers.eval.js";
import {
  routerSuite,
  routerOfflineSuite,
  planSuite,
} from "./router.eval.js";
import type { Suite, SuiteResult } from "./types.js";

/**
 * The eval runner.
 *
 *   npm run eval              offline only — fast, free, deterministic
 *   npm run eval -- --live    also run the suites that call a model
 *   npm run eval -- --json    write evals/report.json as well
 *
 * Exit code is 1 when anything failed, so this works as a CI gate. The offline
 * suites cover every guardrail and both output parsers, which means the gate is
 * meaningful without an API key — the usual reason eval suites get disabled.
 */

const SUITES: Suite[] = [
  guardrailSuite,
  parserSuite,
  planSuite,
  routerOfflineSuite,
  routerSuite,
];

const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

async function runSuite(suite: Suite): Promise<SuiteResult> {
  const started = Date.now();
  const cases = await suite.run();

  const passed = cases.filter((item) => item.passed).length;

  return {
    suite: suite.name,
    kind: suite.kind,
    cases,
    passed,
    failed: cases.length - passed,
    score: cases.length === 0 ? 1 : passed / cases.length,
    durationMs: Date.now() - started,
  };
}

function bar(score: number, width = 20) {
  const filled = Math.round(score * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function colourFor(score: number) {
  if (score === 1) return GREEN;
  if (score >= 0.8) return YELLOW;
  return RED;
}

async function main() {
  const live = process.argv.includes("--live");
  const json = process.argv.includes("--json");

  const selected = SUITES.filter((suite) => live || suite.kind === "offline");

  console.log("");
  console.log(`${BOLD}AI Secretary evals${RESET}`);
  console.log(
    `${DIM}${selected.length} suites · ${live ? "offline + live" : "offline only (pass --live to include model calls)"}${RESET}`,
  );
  console.log("");

  const results: SuiteResult[] = [];

  for (const suite of selected) {
    const result = await runSuite(suite);
    results.push(result);

    const colour = colourFor(result.score);

    console.log(
      `${colour}${bar(result.score)}${RESET} ${BOLD}${result.suite}${RESET} ` +
        `${DIM}(${result.kind})${RESET} ` +
        `${result.passed}/${result.cases.length} ` +
        `${DIM}${result.durationMs}ms${RESET}`,
    );
    console.log(`  ${DIM}${suite.about}${RESET}`);

    for (const item of result.cases.filter((entry) => !entry.passed)) {
      console.log(`  ${RED}✗${RESET} ${item.id} ${DIM}— ${item.about}${RESET}`);
      console.log(
        `      expected ${JSON.stringify(item.expected)}, got ${JSON.stringify(item.actual)}`,
      );
      if (item.note) console.log(`      ${DIM}${item.note}${RESET}`);
    }

    console.log("");
  }

  const totalCases = results.reduce((sum, item) => sum + item.cases.length, 0);
  const totalPassed = results.reduce((sum, item) => sum + item.passed, 0);
  const overall = totalCases === 0 ? 1 : totalPassed / totalCases;

  console.log(`${BOLD}${"─".repeat(52)}${RESET}`);
  console.log(
    `${colourFor(overall)}${bar(overall)}${RESET} ${BOLD}${totalPassed}/${totalCases}${RESET} ` +
      `(${(overall * 100).toFixed(1)}%)`,
  );

  if (!live) {
    console.log(
      `${DIM}Live suites skipped. Run with --live to measure router accuracy.${RESET}`,
    );
  }

  console.log("");

  if (json) {
    const reportDir = path.resolve(process.cwd(), "evals");
    await mkdir(reportDir, { recursive: true });

    const file = path.join(reportDir, "report.json");

    await writeFile(
      file,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          live,
          overall,
          totalCases,
          totalPassed,
          suites: results,
        },
        null,
        2,
      ),
    );

    console.log(`${DIM}Report written to ${file}${RESET}\n`);
  }

  // Non-zero exit so this can gate a commit or a CI job.
  process.exit(totalPassed === totalCases ? 0 : 1);
}

main().catch((error) => {
  console.error("Eval run failed:", error);
  process.exit(1);
});
