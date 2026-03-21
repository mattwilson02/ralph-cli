import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProjectContext, Workspace } from "./types.js";

/**
 * Build a context summary that tells agents what the project is.
 * Used as a prefix in every agent prompt.
 */
export function buildProjectSummary(ctx: ProjectContext): string {
  const workspaceList = ctx.workspaces
    .map(
      (w) =>
        `  - ${w.path} (${w.type}${w.framework ? `, ${w.framework}` : ""})`,
    )
    .join("\n");

  const stackParts = [
    ...ctx.stack.languages,
    ...ctx.stack.frameworks,
    ctx.stack.database,
    ctx.stack.testRunner,
    ctx.stack.linter,
    ctx.stack.buildTool,
  ].filter(Boolean);

  return `## Project: ${ctx.name}
${ctx.description ? `\n${ctx.description}\n` : ""}
**Stack:** ${stackParts.join(", ")}
**Structure:** ${ctx.isMonorepo ? "Monorepo" : "Single app"}
${ctx.isMonorepo ? `**Workspaces:**\n${workspaceList}` : ""}
**Base branch:** ${ctx.git.baseBranch}
`;
}

/**
 * Check if a project is early-stage based on source file count.
 * If any workspace has fewer than 5 source files, it's considered early stage.
 */
export function isEarlyStage(ctx: ProjectContext): boolean {
  if (ctx.workspaces.length === 0) return true;

  const SOURCE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs",
    ".vue", ".svelte", ".astro",
  ]);

  function countSourceFiles(dir: string): number {
    if (!existsSync(dir)) return 0;
    let count = 0;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          count += countSourceFiles(fullPath);
        } else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
          count++;
        }
      }
    } catch {
      // Permission errors, etc.
    }
    return count;
  }

  return ctx.workspaces.some((w) => {
    const wsDir = join(ctx.root, w.path);
    return countSourceFiles(wsDir) < 5;
  });
}

/**
 * Load existing sprint spec files sorted by number.
 */
export function getExistingSpecs(
  sprintsDir: string,
): { number: number; name: string; content: string }[] {
  if (!existsSync(sprintsDir)) return [];
  return readdirSync(sprintsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const match = f.match(/^sprint-(\d+)-(.+)\.md$/);
      if (!match) return null;
      return {
        number: parseInt(match[1], 10),
        name: f.replace(".md", ""),
        content: readFileSync(join(sprintsDir, f), "utf-8"),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a!.number - b!.number) as {
    number: number;
    name: string;
    content: string;
  }[];
}

/**
 * Build the spec writer prompt.
 */
export function buildSpecWriterPrompt(
  ctx: ProjectContext,
  sprintNumber: number,
  greenfield = false,
): string {
  const productSpec = ctx.productSpec
    ? readFileSync(ctx.productSpec, "utf-8")
    : "";

  const previousSpecs = getExistingSpecs(ctx.sprintsDir);
  const previousSpecsSummary = previousSpecs
    .map((s) => `### ${s.name}\n${s.content}`)
    .join("\n\n---\n\n");

  const checksDescription = ctx.workspaces
    .filter((w) => w.checks.length > 0)
    .map(
      (w) =>
        `  ${w.path}: ${w.checks.map((c) => c.cmd).join(", ")}`,
    )
    .join("\n");

  return `You are the sprint planning agent for ${ctx.name}.

## Context

### Project Overview
${buildProjectSummary(ctx)}

### Verification Commands
${checksDescription}

### Product Spec
${productSpec || "No product spec found. Analyze the existing codebase and determine what improvements, features, or fixes would be most valuable."}

### Previous Sprint Specs (already implemented)
${previousSpecsSummary || "No previous sprints. This is the first sprint."}

### Known Documentation
${ctx.docs.length > 0 ? ctx.docs.map((d) => `- ${d}`).join("\n") : "None found."}

## Instructions

1. Read the product spec carefully — it may reference other planning docs (roadmaps, epochs, milestones, feature specs). **Explore those references.** Use Glob and Read to find and read any related planning documents (e.g. docs/, specs/, epochs/, roadmap, vision, milestones).
2. Read the EXISTING codebase to understand established patterns, conventions, and architecture
3. Determine what should be built NEXT based on the project's planning structure:
   - If the project uses epochs/milestones/phases, identify the current one and pick work from it
   - If there are detailed feature specs, read and follow them rather than inventing your own design
   - Respect the project's existing prioritization and sequencing

4. Write the spec with these sections:
   - **Overview** — goal and rationale
   - **What Exists** — relevant prior work
   - **Architectural Decisions** — cross-cutting decisions builders MUST follow. Reference existing patterns by name.
   - **Tasks** — broken down by workspace/scope, each with:
     - Objective
     - Files to create/modify (full paths)
     - Requirements — business rules, edge cases, validation
     - What patterns to follow (reference existing code)
     - Acceptance criteria
     - Test cases
   - **API Response Contracts** — for new endpoints, specify EXACT response shapes
   - **Implementation order** and **Definition of Done**

5. **DO NOT write implementation code.** Focus on WHAT, WHY, and WHERE — not HOW.

6. **Sprint sizing is critical.** Hard constraints:
   - Maximum **15 new files** per sprint
   - Maximum **5 tasks** per sprint
   - If a feature requires both backend AND frontend work totaling more than 15 files, split it
   - Never bundle more than 2 related features in a single sprint
   - A sprint that finishes cleanly is worth more than an ambitious one that times out

${greenfield ? `7. **This is a new project.** Your first sprint spec MUST include project scaffolding: directory structure, configuration files, base patterns, and a small initial feature. Establish the foundation that future sprints build on.\n\n` : ""}IMPORTANT: Write the spec file to ${ctx.sprintsDir}/sprint-${sprintNumber}-<descriptive-name>.md

After writing the file, output ONLY the filename on the last line.`;
}

/**
 * Build a prompt that generates a draft product spec from the codebase.
 */
export function buildDraftSpecPrompt(ctx: ProjectContext): string {
  const docsContent = ctx.docs
    .map((d) => {
      try {
        return `### ${d}\n${readFileSync(d, "utf-8")}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n\n---\n\n");

  return `You are analyzing the project "${ctx.name}" to generate a draft product specification.

## Project Overview
${buildProjectSummary(ctx)}

## Known Documentation
${docsContent || "No documentation files found."}

## Instructions

1. **Explore the entire codebase thoroughly.** Use Glob and Read to understand:
   - What the project does (its purpose, users, domain)
   - What features already exist
   - The architecture and how components connect
   - Any TODOs, FIXMEs, or incomplete features in the code
   - Any existing planning docs, roadmaps, feature requests, or issue trackers referenced in docs
   - README, CONTRIBUTING, ARCHITECTURE, or any other documentation

2. **Generate a PRODUCT_SPEC.md** that captures:
   - **Vision** — what the project is and who it's for (1-2 paragraphs)
   - **Current State** — what's already built and working
   - **Features** — organized list of features to build or improve, grouped by area/domain
     - For each feature: 2-3 bullet points describing what it should do
     - Mark features that partially exist vs completely new
   - **Technical Debt** — known issues, missing tests, incomplete error handling
   - **Out of Scope** — things that explicitly should NOT be built (prevents scope creep)

3. **Prioritize based on what you find.** If the project has existing planning docs, respect their priorities. If not, order by: critical gaps > missing tests > incomplete features > new features > nice-to-haves.

4. **Be specific but concise.** Each feature should be clear enough for an AI sprint planner to break into tasks, but not so detailed that it prescribes implementation.

Write the file to ${ctx.root}/PRODUCT_SPEC.md

After writing the file, output a brief summary of what you found and wrote.`;
}

/**
 * Build spec writer prompt for specless "improvement" mode.
 */
export function buildImprovementPrompt(
  ctx: ProjectContext,
  sprintNumber: number,
): string {
  const previousSpecs = getExistingSpecs(ctx.sprintsDir);
  const previousSpecsSummary = previousSpecs
    .map((s) => `### ${s.name}\n${s.content}`)
    .join("\n\n---\n\n");

  const checksDescription = ctx.workspaces
    .filter((w) => w.checks.length > 0)
    .map(
      (w) =>
        `  ${w.path}: ${w.checks.map((c) => c.cmd).join(", ")}`,
    )
    .join("\n");

  return `You are the sprint planning agent for ${ctx.name}, operating in **improvement mode** (no product spec provided).

## Context

### Project Overview
${buildProjectSummary(ctx)}

### Verification Commands
${checksDescription}

### Known Documentation
${ctx.docs.length > 0 ? ctx.docs.map((d) => `- ${d}`).join("\n") : "None found."}

### Previous Sprint Specs (already implemented)
${previousSpecsSummary || "No previous sprints. This is the first sprint."}

## Instructions

You have NO product spec. Your job is to analyze the codebase and find the most valuable improvements to make.

1. **Explore the codebase thoroughly.** Read key files, tests, docs, configs. Understand what exists.

2. **Identify high-value work** in this priority order:
   - **Broken things** — failing tests, build errors, runtime bugs
   - **Missing tests** — untested code paths, low coverage areas
   - **Incomplete features** — half-built functionality, TODO/FIXME comments
   - **Error handling gaps** — missing validation, unhandled edge cases, silent failures
   - **Code quality** — duplicated logic, inconsistent patterns, dead code
   - **Security** — obvious vulnerabilities, hardcoded secrets, missing input sanitization
   - **Developer experience** — missing types, unclear APIs, missing documentation

3. **Do NOT add new features.** Improvement mode is about making the existing codebase better, not expanding scope.

4. Write the spec with these sections:
   - **Overview** — what you found and why this sprint matters
   - **What Exists** — current state of the areas you're improving
   - **Tasks** — broken down by workspace/scope, each with:
     - Objective
     - Files to create/modify (full paths)
     - Requirements
     - Acceptance criteria
     - Test cases
   - **Implementation order** and **Definition of Done**

5. **Sprint sizing constraints:**
   - Maximum **15 new files** per sprint
   - Maximum **5 tasks** per sprint
   - A sprint that finishes cleanly is worth more than an ambitious one that times out

IMPORTANT: Write the spec file to ${ctx.sprintsDir}/sprint-${sprintNumber}-<descriptive-name>.md

After writing the file, output ONLY the filename on the last line.`;
}

/**
 * Build a prompt for directed task mode (--task flag).
 * Generates a sprint spec inline from a task description.
 */
export function buildTaskPrompt(
  ctx: ProjectContext,
  sprintNumber: number,
  task: string,
): string {
  const checksDescription = ctx.workspaces
    .filter((w) => w.checks.length > 0)
    .map(
      (w) =>
        `  ${w.path}: ${w.checks.map((c) => c.cmd).join(", ")}`,
    )
    .join("\n");

  return `You are the sprint planning agent for ${ctx.name}, working on a directed task.

## Context

### Project Overview
${buildProjectSummary(ctx)}

### Verification Commands
${checksDescription}

### Known Documentation
${ctx.docs.length > 0 ? ctx.docs.map((d) => `- ${d}`).join("\n") : "None found."}

## Directed Task
${task}

## Instructions

1. **Explore the codebase thoroughly.** Use Glob, Read, and Grep to understand the relevant areas of the project — file structure, existing patterns, related code, tests, and conventions.
2. **Understand the task.** Determine what needs to change, where the relevant code lives, and what the impact will be.
3. Write a focused sprint spec with these sections:
   - **Overview** — goal and rationale based on the task
   - **What Exists** — relevant prior work and current state
   - **Architectural Decisions** — cross-cutting decisions builders MUST follow. Reference existing patterns by name.
   - **Tasks** — broken down by workspace/scope, each with:
     - Objective
     - Files to create/modify (full paths)
     - Requirements — business rules, edge cases, validation
     - What patterns to follow (reference existing code)
     - Acceptance criteria
     - Test cases
   - **Implementation order** and **Definition of Done**

4. **DO NOT write implementation code.** Focus on WHAT, WHY, and WHERE — not HOW.

5. **Sprint sizing constraints:**
   - Maximum **15 new files** per sprint
   - Maximum **5 tasks** per sprint
   - A sprint that finishes cleanly is worth more than an ambitious one that times out

IMPORTANT: Write the spec file to ${ctx.sprintsDir}/sprint-${sprintNumber}-<descriptive-name>.md

After writing the file, output ONLY the filename on the last line.`;
}

/**
 * Build a builder prompt for a specific workspace or set of workspaces.
 */
export function buildBuilderPrompt(
  ctx: ProjectContext,
  specContent: string,
  scope: "backend" | "frontend" | "all",
): string {
  const targetWorkspaces = ctx.workspaces.filter((w) => {
    if (scope === "all") return true;
    if (scope === "backend")
      return w.type === "backend" || w.type === "shared";
    return w.type === "frontend";
  });

  const workspaceDescription = targetWorkspaces
    .map(
      (w) =>
        `- ${w.path} (${w.type}${w.framework ? `, ${w.framework}` : ""})`,
    )
    .join("\n");

  const checks = targetWorkspaces.flatMap((w) => w.checks);
  const checksDescription = checks
    .map((c) => `- ${c.name}: \`cd ${c.cwd} && ${c.cmd}\``)
    .join("\n");

  const earlyStage = isEarlyStage(ctx);
  const patternGuidance = earlyStage
    ? "This is an early-stage project. Establish clean patterns based on the framework's best practices and the architectural decisions in the spec. Write idiomatic, well-structured code that future sprints can build on."
    : "Follow existing patterns EXACTLY — do not invent new patterns";

  return `You are the builder agent for ${ctx.name}.

## Your Scope
${workspaceDescription}

## Sprint Spec
${specContent}

## Instructions

1. Read the sprint spec carefully
2. Read the existing codebase to understand patterns and conventions
3. Implement ALL work described in the spec for your scope
4. ${patternGuidance}
5. After implementing, verify your work passes:
${checksDescription}

IMPORTANT:
- Do NOT modify files outside your scope unless the spec explicitly requires it
- Do NOT skip tests — write all tests specified in the spec
- If the spec references shared packages, update them as needed
- Commit nothing — just write the code. The pipeline handles git.`;
}

/**
 * Build a fix agent prompt from verification failures.
 */
export function buildFixPrompt(
  ctx: ProjectContext,
  failures: string,
  specContent: string,
): string {
  return `You are the fix agent for ${ctx.name}.

The builder agent's work has verification failures. Fix them.

## Failures
${failures}

## Sprint Spec (for context)
${specContent}

## Instructions

1. Read the failure output carefully
2. Identify the root cause of each failure
3. Fix the issues — do NOT introduce new features or refactor unrelated code
4. After fixing, verify your changes pass the failing checks

Do NOT modify test expectations to make tests pass — fix the actual code.
Do NOT delete or skip failing tests.`;
}

/**
 * Build an audit prompt.
 */
export function buildAuditPrompt(
  ctx: ProjectContext,
  specContent: string,
): string {
  return `You are the spec compliance auditor for ${ctx.name}.

## Sprint Spec
${specContent}

## Instructions

1. Read the sprint spec
2. Read the code that was written
3. Check every requirement, acceptance criterion, and test case in the spec
4. Report what was completed and what was missed

Output a JSON object:
{
  "completed": ["item 1", "item 2"],
  "missing": ["item 1", "item 2"],
  "issues": ["issue 1", "issue 2"]
}

If everything is complete, set "missing" and "issues" to empty arrays.
Be thorough but fair — minor formatting differences don't count as missing.`;
}
