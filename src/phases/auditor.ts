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

/**
 * Pull the audit JSON out of whatever the model actually returned.
 *
 * The old implementation was a single greedy `/\{[\s\S]*\}/`, which spans
 * from the FIRST brace in the response to the LAST one. Any prose containing
 * a brace, any second JSON object, any fenced block followed by a closing
 * remark, and the captured text is not valid JSON — so a correct audit was
 * recorded as `audit-parse-failure` and the sprint escalated. That accounted
 * for three of the six escalations on the IoM CIS run (sprints 9, 12, 14).
 *
 * Now: try the whole response, then each fenced block, then every
 * brace-balanced object in order. First one that parses to the right shape
 * wins.
 */
export function tryParseAudit(result: string): AuditResult | null {
  for (const candidate of jsonCandidates(result)) {
    try {
      const parsed = JSON.parse(candidate) as Partial<AuditResult>;
      if (
        Array.isArray(parsed.completed) &&
        Array.isArray(parsed.missing) &&
        Array.isArray(parsed.issues)
      ) {
        return {
          completed: parsed.completed,
          missing: parsed.missing,
          issues: parsed.issues,
        };
      }
    } catch {
      // Try the next candidate rather than giving up on the response.
    }
  }
  return null;
}

function* jsonCandidates(raw: string): Generator<string> {
  const text = raw.trim();
  if (text) yield text;

  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1].trim();
    if (inner) yield inner;
  }

  yield* balancedObjects(text);
}

/**
 * Every brace-balanced `{...}` span in the text, outermost-first, ignoring
 * braces that appear inside JSON string literals.
 */
function* balancedObjects(text: string): Generator<string> {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}
