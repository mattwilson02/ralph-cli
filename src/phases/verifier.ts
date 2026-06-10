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
  let allOutput = "";

  for (const check of checks) {
    const { ok, output } = runSafe(check.cmd, ctx.root + "/" + check.cwd);
    const status = ok ? "PASS" : "FAIL";
    log(`  ${status}: ${check.name}`);

    ledger?.recordCheck(attempt, check.name, check.cmd, ok, ok ? undefined : output);

    if (!ok) {
      failedChecks.push(check.name);
      allOutput += `\n--- ${check.name} FAILED ---\n${output}\n`;
    }
  }

  return {
    passed: failedChecks.length === 0,
    output: allOutput,
    failedChecks,
  };
}

/**
 * Run verify + fix loop with retries.
 *
 * Safe iteration policy: if a fix attempt makes no progress (the same set of
 * checks is still failing and nothing previously failing now passes), stop
 * early and escalate instead of burning the remaining attempts on identical
 * failures.
 */
export async function verifyAndFix(
  ctx: ProjectContext,
  scope: "backend" | "frontend" | "full",
  specPath: string,
  fixModel: string,
  maxAttempts: number,
  ledger?: EvidenceLedger,
): Promise<VerifyResult> {
  let previousFailed: string[] | null = null;
  // Handoff between fix attempts: each agent sees what was already tried
  // (including attempts from earlier verify scopes and crash-recovered runs)
  const priorAttempts = [...(ledger?.data?.fixAttempts ?? [])];

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const result = verify(ctx, scope, ledger, attempt);

    if (result.passed) {
      log(`All ${scope} checks passed`);
      return result;
    }

    // No progress since the last attempt — the fix agent is stuck.
    // Escalate now rather than retrying the same failure.
    if (previousFailed && !madeProgress(previousFailed, result.failedChecks)) {
      log(
        `${scope} checks made no progress after fix attempt (still failing: ${result.failedChecks.join(", ")}) — escalating early`,
      );
      ledger?.escalate(
        `Fix loop stalled: ${result.failedChecks.join(", ")} failed twice in a row with no progress (stopped after ${attempt} of ${maxAttempts} fix attempts)`,
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
    previousFailed = result.failedChecks;
  }

  // Unreachable — the loop always returns on the final attempt
  return { passed: false, output: "", failedChecks: [] };
}

/**
 * Progress means at least one previously-failing check now passes.
 * New failures appearing alongside old ones still count as stalled
 * if nothing got fixed.
 */
function madeProgress(previousFailed: string[], currentFailed: string[]): boolean {
  return previousFailed.some((check) => !currentFailed.includes(check));
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
