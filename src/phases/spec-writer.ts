import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectContext } from "../context/types.js";
import {
  buildSpecWriterPrompt,
  buildImprovementPrompt,
  buildTaskPrompt,
  getExistingSpecs,
} from "../context/prompts.js";
import { runAgent } from "../core/agent.js";
import { log } from "../util/logger.js";

interface WriteSpecOptions {
  task?: string;
  greenfield?: boolean;
}

export async function writeSpec(
  ctx: ProjectContext,
  sprintNumber: number,
  model: string,
  options: WriteSpecOptions = {},
): Promise<{ name: string; path: string }> {
  // Check for pre-written spec (skip in task mode — task always generates fresh)
  if (!options.task) {
    const existing = getExistingSpecs(ctx.sprintsDir).find(
      (s) => s.number === sprintNumber,
    );
    if (existing) {
      log(`Using pre-written spec: ${existing.name}`);
      return {
        name: existing.name,
        path: join(ctx.sprintsDir, `${existing.name}.md`),
      };
    }
  }

  // Ensure sprints directory exists
  if (!existsSync(ctx.sprintsDir)) {
    mkdirSync(ctx.sprintsDir, { recursive: true });
  }

  const hasProductSpec = ctx.productSpec && existsSync(ctx.productSpec);
  const mode = options.task ? "task" : hasProductSpec ? "spec" : "improvement";

  log(
    `Writing spec for sprint ${sprintNumber}${mode === "task" ? ` (task: ${options.task})` : mode === "improvement" ? " (improvement mode — no product spec)" : ""}...`,
  );

  let prompt: string;
  let systemPrompt: string;

  if (mode === "task") {
    prompt = buildTaskPrompt(ctx, sprintNumber, options.task!);
    systemPrompt =
      "You are writing a focused sprint spec for a directed task. Explore the codebase to understand the context, then write a precise spec. Focus on WHAT to build, WHY, and WHERE — not HOW. Never write implementation code. Reference existing patterns by name.";
  } else if (mode === "spec") {
    prompt = buildSpecWriterPrompt(ctx, sprintNumber, options.greenfield);
    systemPrompt =
      "You are writing a sprint spec. Focus on WHAT to build, WHY, and WHERE — not HOW. Never write implementation code. Reference existing patterns by name. The builder agents have full codebase access.";
  } else {
    prompt = buildImprovementPrompt(ctx, sprintNumber);
    systemPrompt =
      "You are writing an improvement sprint spec. Analyze the codebase for the most impactful quality improvements. Never add new features — focus on making existing code better. Never write implementation code.";
  }

  await runAgent(prompt, {
    cwd: ctx.root,
    model,
    allowedTools: ["Read", "Write", "Glob", "Grep"],
    maxTurns: 50,
    systemPromptAppend: systemPrompt,
  });

  // Find the spec that was just created
  const specs = getExistingSpecs(ctx.sprintsDir);
  const newSpec = specs.find((s) => s.number === sprintNumber);
  if (!newSpec) {
    throw new Error(
      `Spec writer did not create a sprint-${sprintNumber}-*.md file in ${ctx.sprintsDir}`,
    );
  }

  return {
    name: newSpec.name,
    path: join(ctx.sprintsDir, `${newSpec.name}.md`),
  };
}
