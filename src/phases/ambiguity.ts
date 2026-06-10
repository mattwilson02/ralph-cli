import { readFileSync } from "node:fs";
import type { ProjectContext } from "../context/types.js";
import { runAgent } from "../core/agent.js";
import { log } from "../util/logger.js";

export interface AmbiguityResult {
  actionable: boolean;
  ambiguities: string[];
}

/**
 * Pre-build ambiguity gate: a short, read-only agent pass over the spec
 * before the builder burns 200 turns in a potentially wrong direction.
 * A spec error caught here is a question for the human; caught later it
 * masquerades as an implementation error the fix loop cannot fix.
 *
 * The gate fails open: if the reviewer's output can't be parsed, the spec
 * is treated as actionable (with a warning) — the gate itself must not
 * become a source of stuck sprints.
 */
export async function checkAmbiguity(
  ctx: ProjectContext,
  specPath: string,
  model: string,
): Promise<AmbiguityResult> {
  log("Running pre-build ambiguity check...");

  const specContent = readFileSync(specPath, "utf-8");

  const prompt = `You are reviewing a sprint spec for ${ctx.name} BEFORE a builder agent executes it.

## Sprint Spec
${specContent}

## Instructions

Read the spec and (briefly) the relevant parts of the codebase. Decide whether the spec is actionable as written, or whether it contains ambiguities that would send a builder in the wrong direction:

- Contradictory requirements
- Missing information the builder cannot infer from the codebase (e.g. unspecified API contracts, unclear data ownership)
- References to files, patterns, or features that do not exist
- Requirements that conflict with the existing architecture

Do NOT flag minor stylistic gaps or things a competent builder can resolve by reading the code. Only flag ambiguities that genuinely need a human decision.

Output ONLY a JSON object:
{
  "actionable": true | false,
  "ambiguities": ["question 1", "question 2"]
}

If actionable is true, ambiguities must be an empty array.`;

  const result = await runAgent(prompt, {
    cwd: ctx.root,
    model,
    allowedTools: ["Read", "Glob", "Grep"],
    maxTurns: 15,
    systemPromptAppend:
      "You are a spec reviewer. You are read-only. Output JSON only.",
  });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<AmbiguityResult>;
      if (typeof parsed.actionable === "boolean") {
        const ambiguities = Array.isArray(parsed.ambiguities)
          ? parsed.ambiguities
          : [];
        if (parsed.actionable) {
          log("  Spec is actionable");
        } else {
          log(`  Spec has ${ambiguities.length} ambiguities needing human input`);
        }
        return { actionable: parsed.actionable, ambiguities };
      }
    }
  } catch {
    // fall through to fail-open below
  }

  log("  Warning: ambiguity check output unparseable — proceeding (gate fails open)");
  return { actionable: true, ambiguities: [] };
}
