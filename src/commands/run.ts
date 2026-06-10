import { resolve, join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { scanProject } from "../context/scanner.js";
import { runEngine } from "../core/engine.js";
import { loadConfig } from "../config.js";
import { loadState } from "../core/state.js";
import { listBranches } from "../util/git.js";
import { log } from "../util/logger.js";
import { ask, isInteractive } from "../util/prompt.js";
import { DEFAULT_MODELS } from "../types.js";
import type { AutonomyMode, EngineOptions } from "../types.js";

function detectNextSprint(sprintsDir: string, root: string): number {
  let maxSprint = 0;

  // Check existing spec files (sprint-N-*.md)
  try {
    const files = readdirSync(sprintsDir);
    for (const f of files) {
      const match = f.match(/^sprint-(\d+)-/);
      if (match) {
        maxSprint = Math.max(maxSprint, parseInt(match[1], 10));
      }
    }
  } catch {
    // No sprints dir yet
  }

  // Check existing branches (sprint/sprint-N-*)
  const branches = listBranches(root);
  for (const b of branches) {
    const match = b.match(/^sprint\/sprint-(\d+)-/);
    if (match) {
      maxSprint = Math.max(maxSprint, parseInt(match[1], 10));
    }
  }

  return maxSprint + 1;
}

interface RunFlags {
  dir?: string;
  sprint?: string;
  maxSprints?: string;
  single?: boolean;
  improve?: boolean;
  spec?: string;
  task?: string;
  maxFixAttempts?: string;
  sprintTimeout?: string;
  specModel?: string;
  buildModel?: string;
  fixModel?: string;
  auditModel?: string;
  autonomy?: string;
  approve?: boolean;
  goal?: string;
}

function isGreenfield(ctx: ReturnType<typeof scanProject>): boolean {
  return (
    ctx.workspaces.length === 0 ||
    ctx.workspaces.every((w) => w.checks.length === 0)
  );
}

export async function run(flags: RunFlags): Promise<void> {
  // Ralph uses the Claude Agent SDK which authenticates via Claude Code.
  // Users need either: Claude Code login (claude login) or ANTHROPIC_API_KEY.
  // The SDK handles auth internally — we just check claude is available.


  const root = resolve(flags.dir || ".");
  const ctx = scanProject(root);
  const config = loadConfig(root);

  // Priority: --spec flag > .ralph.yaml > scanner auto-detect
  if (flags.spec) {
    ctx.productSpec = resolve(flags.spec);
  } else if (config?.spec) {
    ctx.productSpec = join(root, config.spec);
  }

  // Apply base branch from config
  if (config?.baseBranch) {
    ctx.git.baseBranch = config.baseBranch;
  }

  if (!ctx.productSpec && !flags.task && !flags.improve) {
    log("No product spec found.");
    log("Ralph is spec-driven — he needs a product spec to plan sprints.\n");
    log("  Generate one:  ralph spec");
    log("  Point to one:  ralph init --spec path/to/PRODUCT_SPEC.md");
    log("  Or run:        ralph run --improve  (specless codebase improvements)\n");
    process.exit(1);
  }

  // Detect greenfield projects — but not if sprints already exist
  const nextSprint = detectNextSprint(ctx.sprintsDir, root);
  const greenfield = isGreenfield(ctx) && nextSprint === 1;
  if (greenfield) {
    log("Greenfield project detected — Ralph will scaffold before building.");
  }

  // Resume from saved state, or detect next sprint from existing specs/branches
  const savedState = loadState(root);
  const defaultSprint = savedState
    ? savedState.sprint
    : nextSprint;

  // Autonomy: explicit human choice (flag > config) overrides Ralph's
  // risk-based judgment; undefined lets the engine judge per sprint
  let autonomy: AutonomyMode | undefined;
  if (flags.autonomy === "auto" || flags.autonomy === "plan-first") {
    autonomy = flags.autonomy;
  } else if (flags.autonomy) {
    log(`Unknown --autonomy value "${flags.autonomy}" — expected auto or plan-first`);
    process.exit(1);
  } else {
    autonomy = config?.autonomy;
  }

  // Intake / scope screening: inherit the codeowner's goal before setting
  // off. Task mode carries its goal in the flag; otherwise use --goal, a
  // previously saved goal, or a short interactive intake on a fresh run.
  const inheritedGoal = await resolveGoal(root, flags, savedState !== null);

  const opts: EngineOptions = {
    startSprint: parseInt(flags.sprint || String(defaultSprint), 10),
    maxSprints: parseInt(flags.maxSprints || "10", 10),
    singleMode: flags.task ? true : (flags.single ?? false),
    improve: flags.improve ?? false,
    task: flags.task,
    greenfield,
    maxFixAttempts: parseInt(flags.maxFixAttempts || "3", 10),
    maxResumeAttempts: 3,
    sprintTimeout: parseInt(flags.sprintTimeout || "45", 10),
    onVerifyFailure: config?.onVerifyFailure || "draft-pr",
    autonomy,
    approve: flags.approve ?? false,
    goal: inheritedGoal,
    models: {
      specWriter: flags.specModel || DEFAULT_MODELS.specWriter,
      builder: flags.buildModel || DEFAULT_MODELS.builder,
      fixAgent: flags.fixModel || DEFAULT_MODELS.fixAgent,
      auditor: flags.auditModel || DEFAULT_MODELS.auditor,
    },
  };

  await runEngine(ctx, opts);
}

/**
 * Inherit the codeowner's goal — the first link of the audit trail.
 * Priority: --task (is its own goal, recorded by the engine) > --goal >
 * saved .ralph/goal.md > interactive intake (TTY, fresh runs only).
 */
async function resolveGoal(
  root: string,
  flags: RunFlags,
  resuming: boolean,
): Promise<string | undefined> {
  if (flags.task) return undefined; // engine derives the goal from the task

  const goalPath = join(root, ".ralph", "goal.md");

  if (flags.goal) {
    saveGoal(goalPath, flags.goal);
    return flags.goal;
  }

  if (existsSync(goalPath)) {
    const saved = readFileSync(goalPath, "utf-8").trim();
    if (saved) return saved;
  }

  // Fresh interactive run with no goal on record — short intake
  if (!resuming && isInteractive()) {
    return intake(goalPath);
  }

  return undefined;
}

async function intake(goalPath: string): Promise<string | undefined> {
  log("Intake — a few questions before Ralph sets off (Enter to skip any):\n");

  const goal = await ask("  What should this run achieve? ");
  if (!goal) {
    log("  No goal given — Ralph will work from the product spec.\n");
    return undefined;
  }

  const constraints = await ask("  Any constraints (tech, style, deadlines)? ");
  const outOfScope = await ask("  Anything explicitly out of scope? ");

  const parts = [goal];
  if (constraints) parts.push(`Constraints: ${constraints}`);
  if (outOfScope) parts.push(`Out of scope: ${outOfScope}`);
  const composed = parts.join("\n");

  saveGoal(goalPath, composed);
  log("");
  return composed;
}

function saveGoal(goalPath: string, goal: string): void {
  const dir = dirname(goalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(goalPath, goal.trim() + "\n");
}
