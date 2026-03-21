import type { ProjectContext } from "../context/types.js";
import type { EngineOptions } from "../types.js";
import { loadState, saveState, clearState } from "./state.js";
import { writeSpec } from "../phases/spec-writer.js";
import { runBuilders } from "../phases/builder.js";
import { verifyAndFix } from "../phases/verifier.js";
import { auditSpec } from "../phases/auditor.js";
import { ship } from "../phases/shipper.js";
import {
  createBranch,
  renameBranch,
  checkoutBranch,
  pullLatest,
  listBranches,
  isBranchMergedInto,
} from "../util/git.js";
import { log, initLogger } from "../util/logger.js";

export async function runEngine(
  ctx: ProjectContext,
  opts: EngineOptions,
): Promise<void> {
  initLogger(ctx.root);
  log("═".repeat(60));
  log(`  Ralph — ${ctx.name}`);
  log(`  Base branch: ${ctx.git.baseBranch}`);
  log(`  Starting at sprint: ${opts.startSprint}`);
  log(`  Max sprints: ${opts.maxSprints}`);
  if (opts.task) log(`  Task: ${opts.task}`);
  if (opts.greenfield) log(`  Mode: greenfield`);
  if (opts.improve) log(`  Mode: improve`);
  log(`  Sprint timeout: ${opts.sprintTimeout} min`);
  log("═".repeat(60));

  const endSprint = opts.startSprint + opts.maxSprints;

  // Find the previous sprint's branch for chaining (if starting at sprint > 1)
  let previousBranch: string | null = null;
  if (opts.startSprint > 1) {
    previousBranch = findPreviousSprintBranch(ctx.root, opts.startSprint, ctx.git.baseBranch);
    if (previousBranch) {
      log(`  Chaining from previous sprint branch: ${previousBranch}`);
    }
  }

  for (let sprint = opts.startSprint; sprint < endSprint; sprint++) {
    const startTime = Date.now();

    log("");
    log("═".repeat(60));
    log(`  SPRINT ${sprint}`);
    log("═".repeat(60));

    // Check for saved state (resume from crash)
    let state = loadState(ctx.root);
    let specName = state?.specName;
    let specPath = state?.specPath;
    let branchName = state?.branchName;

    const resuming = state !== null && state.sprint === sprint;
    const startPhase = resuming ? state!.phase : "spec";

    // Determine parent branch for chaining
    const parentBranch = previousBranch || ctx.git.baseBranch;

    if (!resuming) {
      // Chain sprints: branch from previous sprint if available, otherwise from base
      checkoutBranch(ctx.root, parentBranch);
      if (!previousBranch) {
        // Only pull from remote when starting from base branch
        pullLatest(ctx.root, ctx.git.baseBranch);
      }
      createBranch(ctx.root, `sprint/${sprint}`);
      log(`  Branched from: ${parentBranch}`);
    }

    const timeoutMs = opts.sprintTimeout * 60 * 1000;
    const isTimedOut = () => Date.now() - startTime > timeoutMs;

    try {
      // ── Phase: Spec ──
      if (shouldRun(startPhase, "spec")) {
        const spec = await writeSpec(ctx, sprint, opts.models.specWriter, {
          task: opts.task,
          greenfield: opts.greenfield,
          improve: opts.improve,
        });
        specName = spec.name;
        specPath = spec.path;
        branchName = `sprint/${specName}`;
        renameBranch(ctx.root, branchName);

        saveState(ctx.root, {
          sprint,
          phase: "build",
          specName,
          specPath,
          branchName,
        });
      }

      if (!specPath || !specName || !branchName) {
        throw new Error("No spec available — cannot continue");
      }

      // ── Phase: Build ──
      if (shouldRun(startPhase, "build")) {
        await runBuilders(ctx, specPath, opts.models.builder);

        saveState(ctx.root, {
          sprint,
          phase: "build_verify",
          specName,
          specPath,
          branchName,
        });
      }

      // ── Phase: Build Verify (with fix loop) ──
      if (shouldRun(startPhase, "build_verify") && !isTimedOut()) {
        const hasBackend = ctx.workspaces.some(
          (w) => w.type === "backend" || w.type === "shared",
        );
        const hasFrontend = ctx.workspaces.some(
          (w) => w.type === "frontend",
        );

        if (hasBackend && hasFrontend) {
          // Verify backend first, then full
          await verifyAndFix(
            ctx,
            "backend",
            specPath,
            opts.models.fixAgent,
            opts.maxFixAttempts,
          );
        }

        saveState(ctx.root, {
          sprint,
          phase: "full_verify",
          specName,
          specPath,
          branchName,
        });
      }

      // ── Phase: Full Verify ──
      if (shouldRun(startPhase, "full_verify") && !isTimedOut()) {
        const passed = await verifyAndFix(
          ctx,
          "full",
          specPath,
          opts.models.fixAgent,
          opts.maxFixAttempts,
        );

        if (!passed) {
          log("Full verification failed — shipping anyway with known issues");
        }

        saveState(ctx.root, {
          sprint,
          phase: "audit",
          specName,
          specPath,
          branchName,
        });
      }

      // ── Phase: Audit ──
      if (shouldRun(startPhase, "audit") && !isTimedOut()) {
        const audit = await auditSpec(ctx, specPath, opts.models.auditor);

        if (audit.missing.length > 0) {
          log(`Audit found ${audit.missing.length} missing items — attempting to fix`);
          // Re-run builder for missing items, then re-verify
          await runBuilders(ctx, specPath, opts.models.builder);
          await verifyAndFix(
            ctx,
            "full",
            specPath,
            opts.models.fixAgent,
            opts.maxFixAttempts,
          );
        }

        saveState(ctx.root, {
          sprint,
          phase: "pr",
          specName,
          specPath,
          branchName,
        });
      }

      if (isTimedOut()) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        log(`\nSprint timeout after ${elapsed} min — shipping with current state`);
      }

      // ── Phase: PR ──
      if (shouldRun(startPhase, "pr")) {
        ship(ctx, branchName, specName, previousBranch || undefined);
      }

      // Sprint complete
      clearState(ctx.root);
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      log(`\nSprint ${sprint} complete in ${elapsed} minutes`);

      // Track this branch so the next sprint chains from it
      previousBranch = branchName;

      if (opts.singleMode) {
        log("Single mode — stopping after one sprint");
        break;
      }
    } catch (err) {
      log(`Sprint ${sprint} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  log("\nRalph finished.");
}

/**
 * Find the branch for the previous sprint by scanning local branches.
 * Returns null if no branch found OR if it's already merged into base
 * (in which case base branch has all the work and is the better parent).
 */
function findPreviousSprintBranch(
  root: string,
  currentSprint: number,
  baseBranch: string,
): string | null {
  const branches = listBranches(root);
  const prevNumber = currentSprint - 1;
  const match = branches.find((b) =>
    b.match(new RegExp(`^sprint/sprint-${prevNumber}-`)),
  );
  if (!match) return null;

  // If the branch is already merged into base, use base instead
  if (isBranchMergedInto(root, match, baseBranch)) {
    log(`  Previous sprint branch ${match} already merged into ${baseBranch} — starting from ${baseBranch}`);
    return null;
  }

  return match;
}

const PHASE_ORDER = [
  "spec",
  "build",
  "build_verify",
  "full_verify",
  "audit",
  "pr",
] as const;

function shouldRun(startPhase: string, currentPhase: string): boolean {
  const startIdx = PHASE_ORDER.indexOf(
    startPhase as (typeof PHASE_ORDER)[number],
  );
  const currentIdx = PHASE_ORDER.indexOf(
    currentPhase as (typeof PHASE_ORDER)[number],
  );
  return currentIdx >= startIdx;
}
