import { readFileSync } from "node:fs";
import type { ProjectContext, Check } from "../context/types.js";
import { buildFixPrompt } from "../context/prompts.js";
import { runAgent } from "../core/agent.js";
import type { EvidenceLedger } from "../core/evidence.js";
import { parseDeclaredFiles } from "../core/risk.js";
import { runSafe } from "../util/exec.js";
import { log } from "../util/logger.js";
import type { VerifyResult } from "../types.js";

/**
 * Run verification checks for the given scope.
 */
export function verify(
  ctx: ProjectContext,
  scope: "backend" | "frontend" | "full",
  ledger?: EvidenceLedger,
  attempt: number = 0,
): VerifyResult {
  const checks = getChecksForScope(ctx, scope);

  log(`Running ${checks.length} verification checks (${scope})...`);

  const failedChecks: string[] = [];
  const failureCounts: Record<string, number> = {};
  let allOutput = "";

  for (const check of checks) {
    const { ok, output } = runSafe(check.cmd, ctx.root + "/" + check.cwd);
    const status = ok ? "PASS" : "FAIL";

    ledger?.recordCheck(attempt, check.name, check.cmd, ok, ok ? undefined : output);

    if (!ok) {
      const count = countFailures(output);
      failedChecks.push(check.name);
      failureCounts[check.name] = count;
      allOutput += `\n--- ${check.name} FAILED ---\n${output}\n`;
      log(`  ${status}: ${check.name} (${count} failing)`);
    } else {
      log(`  ${status}: ${check.name}`);
    }
  }

  return {
    passed: failedChecks.length === 0,
    output: allOutput,
    failedChecks,
    failureCounts,
  };
}

/**
 * How many things are failing inside one check.
 *
 * Deliberately arithmetic and not an LLM judgment: the signal needed here is
 * already an integer sitting in the test runner's output, and a model asked
 * to count would cost a call on every fix iteration, add latency to a loop
 * that is already the slowest part of a sprint, and be worse at counting
 * than a regex. Judgment gets a model; counting gets a count.
 *
 * Falls back to 1 when nothing parses, so an uncountable failure still reads
 * as failing — never as progress.
 */
export function countFailures(output: string): number {
  const patterns: RegExp[] = [
    /Tests?:\s*(\d+)\s+failed/i,      // jest summary line
    /(\d+)\s+failed/i,                // vitest "12 failed | 40 passed"
    /Found\s+(\d+)\s+errors?/i,       // tsc
    /(\d+)\s+problems?\b/i,           // eslint "✖ 12 problems"
    /(\d+)\s+errors?\b/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }

  const markers = output.match(/^\s*(?:✕|✗|×|FAIL\b|error\b)/gim);
  return markers && markers.length > 0 ? markers.length : 1;
}

/**
 * Run verify + fix loop with retries.
 *
 * Safe iteration policy: if a fix attempt makes no progress — no check
 * recovered AND the total number of failures did not fall — stop early and
 * escalate instead of burning the remaining attempts on identical failures.
 * Progress is measured by volume, not by check name; see `madeProgress`.
 */
export async function verifyAndFix(
  ctx: ProjectContext,
  scope: "backend" | "frontend" | "full",
  specPath: string,
  fixModel: string,
  maxAttempts: number,
  ledger?: EvidenceLedger,
): Promise<VerifyResult> {
  let previous: VerifyResult | null = null;
  // Handoff between fix attempts: each agent sees what was already tried
  // (including attempts from earlier verify scopes and crash-recovered runs)
  const priorAttempts = [...(ledger?.data?.fixAttempts ?? [])];

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const result = verify(ctx, scope, ledger, attempt);

    if (result.passed) {
      log(`All ${scope} checks passed`);
      ledger?.noteProgress(`${scope} verification passed`);
      return result;
    }

    if (previous && madeProgress(previous, result)) {
      ledger?.noteProgress(
        `${scope} failures ${totalFailures(previous)} -> ${totalFailures(result)}`,
      );
    }

    // No progress since the last attempt — the fix agent is stuck.
    // Escalate now rather than retrying the same failure.
    if (previous && !madeProgress(previous, result)) {
      log(
        `${scope} checks made no progress after fix attempt (still failing: ${result.failedChecks.join(", ")}, ` +
          `${totalFailures(previous)} -> ${totalFailures(result)} failures) — escalating early`,
      );
      ledger?.escalate(
        `Fix loop stalled: ${result.failedChecks.join(", ")} failed twice in a row with no progress — ` +
          `${totalFailures(previous)} failing before, ${totalFailures(result)} after ` +
          `(stopped after ${attempt} of ${maxAttempts} fix attempts)`,
      );
      return result;
    }

    if (attempt === maxAttempts) {
      log(
        `${scope} checks still failing after ${maxAttempts} fix attempts: ${result.failedChecks.join(", ")}`,
      );
      return result;
    }

    log(
      `Fix attempt ${attempt + 1}/${maxAttempts} for: ${result.failedChecks.join(", ")}`,
    );

    const specContent = readFileSync(specPath, "utf-8");
    const fixPrompt = buildFixPrompt(ctx, result.output, specContent, priorAttempts);

    const fixSummary = await runAgent(fixPrompt, {
      cwd: ctx.root,
      model: fixModel,
      allowedTools: [
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
      ],
      maxTurns: 30,
      systemPromptAppend:
        "You are a fix agent. Fix the verification failures. Do NOT introduce new features. Do NOT delete or skip failing tests. End with a one-paragraph summary of what you changed and why.",
      guardrails: {
        role: "fixer",
        root: ctx.root,
        declaredPaths: parseDeclaredFiles(specContent),
        onToolUse: ledger ? (entry) => ledger.recordToolUse(entry) : undefined,
      },
    });

    ledger?.recordFixAttempt(attempt, result.failedChecks, fixSummary);
    priorAttempts.push({
      attempt,
      failedChecks: result.failedChecks,
      summary: fixSummary.slice(0, 1000),
    });
    previous = result;
  }

  // Unreachable — the loop always returns on the final attempt
  return { passed: false, output: "", failedChecks: [], failureCounts: {} };
}

/**
 * Progress is either a previously-failing check now passing, OR the total
 * volume of failures going down.
 *
 * The second clause is the fix. Comparing check NAMES alone made all
 * movement inside a check invisible — 40 failing tests down to 1 still left
 * "Unit Tests" in the failed set, scored as zero progress, and stopped the
 * loop "after 1 of 3 fix attempts". On the IoM CIS run that is what turned
 * one feature (expiry-watch) into three sprints.
 */
export function madeProgress(
  previous: VerifyResult,
  current: VerifyResult,
): boolean {
  const checkNowPasses = previous.failedChecks.some(
    (check) => !current.failedChecks.includes(check),
  );
  if (checkNowPasses) return true;

  return totalFailures(current) < totalFailures(previous);
}

function totalFailures(result: VerifyResult): number {
  return Object.values(result.failureCounts).reduce((a, b) => a + b, 0);
}

function getChecksForScope(
  ctx: ProjectContext,
  scope: "backend" | "frontend" | "full",
): Check[] {
  if (scope === "full") {
    return ctx.workspaces.flatMap((w) => w.checks);
  }

  return ctx.workspaces
    .filter((w) => {
      if (scope === "backend")
        return w.type === "backend" || w.type === "shared";
      return w.type === "frontend";
    })
    .flatMap((w) => w.checks);
}
