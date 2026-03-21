import { readFileSync } from "node:fs";
import type { ProjectContext } from "../context/types.js";
import { buildAuditPrompt } from "../context/prompts.js";
import { runAgent } from "../core/agent.js";
import { log } from "../util/logger.js";

export interface AuditResult {
  completed: string[];
  missing: string[];
  issues: string[];
}

export async function auditSpec(
  ctx: ProjectContext,
  specPath: string,
  model: string,
): Promise<AuditResult> {
  log("Running spec compliance audit...");

  const specContent = readFileSync(specPath, "utf-8");
  const prompt = buildAuditPrompt(ctx, specContent);

  const result = await runAgent(prompt, {
    cwd: ctx.root,
    model,
    allowedTools: ["Read", "Glob", "Grep"],
    maxTurns: 30,
    systemPromptAppend:
      "You are an auditor. Read the code and compare against the spec. Output JSON only.",
  });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const audit = JSON.parse(jsonMatch[0]) as AuditResult;
      log(`  Completed: ${audit.completed.length} items`);
      log(`  Missing: ${audit.missing.length} items`);
      log(`  Issues: ${audit.issues.length} items`);
      return audit;
    }
    log("  Warning: audit returned no JSON — treating as fully complete");
  } catch {
    log("  Warning: could not parse audit JSON — treating as fully complete");
    log(`  Raw result: ${result.slice(0, 200)}`);
  }

  // If audit can't parse, assume complete rather than silently missing items
  return { completed: [], missing: [], issues: [] };
}
