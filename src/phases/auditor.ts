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

/** Sentinel issue recorded when the auditor's output cannot be parsed. */
export const AUDIT_PARSE_FAILURE = "audit-parse-failure";

export async function auditSpec(
  ctx: ProjectContext,
  specPath: string,
  model: string,
  buildReport?: string | null,
): Promise<AuditResult> {
  log("Running spec compliance audit...");

  const specContent = readFileSync(specPath, "utf-8");
  const prompt = buildAuditPrompt(ctx, specContent, buildReport);

  for (let attempt = 0; attempt < 2; attempt++) {
    const currentPrompt =
      attempt === 0
        ? prompt
        : prompt +
          "\n\nIMPORTANT: Your previous response could not be parsed. Output ONLY the JSON object — no prose, no code fences, no explanation.";

    if (attempt > 0) {
      log("  Audit output unparseable — retrying with corrective prompt");
    }

    const result = await runAgent(currentPrompt, {
      cwd: ctx.root,
      model,
      allowedTools: ["Read", "Glob", "Grep"],
      maxTurns: 30,
      systemPromptAppend:
        "You are an auditor. Read the code and compare against the spec. Output JSON only.",
    });

    const audit = tryParseAudit(result);
    if (audit) {
      log(`  Completed: ${audit.completed.length} items`);
      log(`  Missing: ${audit.missing.length} items`);
      log(`  Issues: ${audit.issues.length} items`);
      return audit;
    }
    log(`  Warning: could not parse audit JSON (attempt ${attempt + 1}/2)`);
    log(`  Raw result: ${result.slice(0, 200)}`);
  }

  // Unknown is not the same as passed: surface the parse failure as an
  // audit issue so the policy gate escalates instead of shipping blind.
  log(`  Audit unparseable after retry — recording ${AUDIT_PARSE_FAILURE}`);
  return { completed: [], missing: [], issues: [AUDIT_PARSE_FAILURE] };
}

export function tryParseAudit(result: string): AuditResult | null {
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Partial<AuditResult>;
    if (
      !Array.isArray(parsed.completed) ||
      !Array.isArray(parsed.missing) ||
      !Array.isArray(parsed.issues)
    ) {
      return null;
    }
    return {
      completed: parsed.completed,
      missing: parsed.missing,
      issues: parsed.issues,
    };
  } catch {
    return null;
  }
}
