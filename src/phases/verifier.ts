import { readFileSync } from "node:fs";
import type { ProjectContext, Check } from "../context/types.js";
import { buildFixPrompt } from "../context/prompts.js";
import { runAgent } from "../core/agent.js";
import { runSafe } from "../util/exec.js";
import { log } from "../util/logger.js";
import type { VerifyResult } from "../types.js";

/**
 * Run verification checks for the given scope.
 */
export function verify(
  ctx: ProjectContext,
  scope: "backend" | "frontend" | "full",
): VerifyResult {
  const checks = getChecksForScope(ctx, scope);

  log(`Running ${checks.length} verification checks (${scope})...`);

  const failedChecks: string[] = [];
  let allOutput = "";

  for (const check of checks) {
    const { ok, output } = runSafe(check.cmd, ctx.root + "/" + check.cwd);
    const status = ok ? "PASS" : "FAIL";
    log(`  ${status}: ${check.name}`);

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
 */
export async function verifyAndFix(
  ctx: ProjectContext,
  scope: "backend" | "frontend" | "full",
  specPath: string,
  fixModel: string,
  maxAttempts: number,
): Promise<boolean> {
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const result = verify(ctx, scope);

    if (result.passed) {
      log(`All ${scope} checks passed`);
      return true;
    }

    if (attempt === maxAttempts) {
      log(
        `${scope} checks still failing after ${maxAttempts} fix attempts: ${result.failedChecks.join(", ")}`,
      );
      return false;
    }

    log(
      `Fix attempt ${attempt + 1}/${maxAttempts} for: ${result.failedChecks.join(", ")}`,
    );

    const specContent = readFileSync(specPath, "utf-8");
    const fixPrompt = buildFixPrompt(ctx, result.output, specContent);

    await runAgent(fixPrompt, {
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
        "You are a fix agent. Fix the verification failures. Do NOT introduce new features. Do NOT delete or skip failing tests.",
    });
  }

  return false;
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
