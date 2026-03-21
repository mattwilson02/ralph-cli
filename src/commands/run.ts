import { resolve, join } from "node:path";
import { readdirSync } from "node:fs";
import { scanProject } from "../context/scanner.js";
import { runEngine } from "../core/engine.js";
import { loadConfig } from "../config.js";
import { loadState } from "../core/state.js";
import { listBranches } from "../util/git.js";
import { log } from "../util/logger.js";
import { DEFAULT_MODELS } from "../types.js";
import type { EngineOptions } from "../types.js";

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
  spec?: string;
  task?: string;
  maxFixAttempts?: string;
  specModel?: string;
  buildModel?: string;
  fixModel?: string;
  auditModel?: string;
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

  if (!ctx.productSpec && !flags.task) {
    log("No product spec found — running in improvement mode.");
    log("Ralph will analyze the codebase and fix quality issues.\n");
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

  const opts: EngineOptions = {
    startSprint: parseInt(flags.sprint || String(defaultSprint), 10),
    maxSprints: parseInt(flags.maxSprints || "10", 10),
    singleMode: flags.task ? true : (flags.single ?? false),
    task: flags.task,
    greenfield,
    maxFixAttempts: parseInt(flags.maxFixAttempts || "3", 10),
    maxResumeAttempts: 3,
    models: {
      specWriter: flags.specModel || DEFAULT_MODELS.specWriter,
      builder: flags.buildModel || DEFAULT_MODELS.builder,
      fixAgent: flags.fixModel || DEFAULT_MODELS.fixAgent,
      auditor: flags.auditModel || DEFAULT_MODELS.auditor,
    },
  };

  await runEngine(ctx, opts);
}
